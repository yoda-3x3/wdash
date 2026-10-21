import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SDKResultMessage,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
  USAGE_LIMIT_ERROR_PREFIXES,
} from "@anthropic-ai/claude-agent-sdk";
import { truncate, sessionProjectKey, type AgentRecord, type AgentStatus } from "@wdash/shared";
import { AsyncQueue } from "./asyncQueue.js";
import { decide, DISALLOWED_TOOLS, type PolicyContext } from "./permissions.js";
import { redisSessionStore } from "./sessionStore.js";
import type { Relay } from "./relay.js";

export type ApprovalOutcome = { allow: boolean; message?: string; scope?: "once" | "job" };

/** What an agent needs from the job that owns it. Implemented by JobRunner. */
export interface AgentHost {
  readonly relay: Relay;
  readonly jobId: string;
  policyContext(agent: AgentRunner): Promise<PolicyContext>;
  requestPermission(agent: AgentRunner, tool: string, input: Record<string, unknown>, title: string, rule: string, signal: AbortSignal): Promise<ApprovalOutcome>;
  askQuestion(agent: AgentRunner, input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, string> | undefined>;
  onTurnEnd(agent: AgentRunner, result: SDKResultMessage): Promise<void>;
  onAgentError(agent: AgentRunner, kind: "usage_limit" | "error", detail: string): Promise<void>;
  onRateLimit(info: Record<string, unknown>): Promise<void>;
  mcpServer(agent: AgentRunner): McpSdkServerConfigWithInstance;
}

export type AgentOptions = {
  cwd: string;
  systemAppend: string;
  /** Extra env for the Claude Code subprocess (e.g. CLAUDE_CODE_OAUTH_TOKEN in the cloud). */
  env?: Record<string, string | undefined>;
};

/** One Agent SDK session (orchestrator or worker), kept alive across turns via streaming input. */
export class AgentRunner {
  private inbox = new AsyncQueue<SDKUserMessage>();
  private q: Query | undefined;
  private abort = new AbortController();
  private loop: Promise<void> | undefined;
  /** Tool-use ids of Agent/Task calls, so subagent output can be nested under them. */
  private subagentCalls = new Map<string, string>();
  busy = false;

  /** Cost from earlier runs of this agent: the SDK's total_cost_usd starts from zero on every resume. */
  private readonly baseCostUsd: number;

  constructor(
    private readonly host: AgentHost,
    public rec: AgentRecord,
    private readonly opts: AgentOptions,
  ) {
    this.baseCostUsd = rec.costUsd || 0;
  }

  get id(): string {
    return this.rec.id;
  }

  get cwd(): string {
    return this.opts.cwd;
  }

  async setStatus(status: AgentStatus): Promise<void> {
    if (this.rec.status === status) return;
    this.rec = { ...this.rec, status };
    await this.save();
    await this.host.relay.emit({ jobId: this.host.jobId, agentId: this.id, type: "status", payload: { agent: this.id, status } });
  }

  async save(): Promise<void> {
    await this.host.relay.putAgent(this.host.jobId, this.rec);
  }

  /** Start (or resume, if rec.sessionId is set) the session. */
  start(firstPrompt?: string): void {
    if (this.loop) return;
    if (firstPrompt) this.send(firstPrompt);
    this.q = query({ prompt: this.inbox, options: this.options() });
    this.loop = this.consume().catch(async (e) => {
      await this.host.onAgentError(this, "error", (e as Error).message ?? String(e));
    });
  }

  /** Queue a user turn. If the agent is mid-turn the SDK delivers it after the current step. */
  send(text: string): void {
    this.busy = true;
    this.inbox.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
  }

  async interrupt(): Promise<void> {
    await this.q?.interrupt().catch(() => undefined);
  }

  /** @param persist false when another runner now owns the job and its state must not be overwritten. */
  async stop(final: AgentStatus = "stopped", persist = true): Promise<void> {
    this.inbox.close();
    this.abort.abort();
    this.q?.close();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    if (persist) await this.setStatus(final);
  }

  /** Tear down and start again from the saved session (used by "Retry agent" and resume). */
  async restart(prompt: string): Promise<void> {
    this.inbox.close();
    this.q?.close();
    await this.loop?.catch(() => undefined);
    this.loop = undefined;
    this.inbox = new AsyncQueue();
    this.abort = new AbortController();
    this.start(prompt);
  }

  private options() {
    const canUseTool: CanUseTool = async (tool, input, { signal }) => {
      await this.touch();
      const d = decide(tool, input, await this.host.policyContext(this));
      switch (d.kind) {
        case "allow":
          return { behavior: "allow", updatedInput: input };
        case "deny":
          return { behavior: "deny", message: d.message };
        case "question": {
          const answers = await this.host.askQuestion(this, input, signal);
          if (!answers) return { behavior: "deny", message: "The user didn't answer." };
          return { behavior: "allow", updatedInput: { ...input, answers } };
        }
        case "ask": {
          const out = await this.host.requestPermission(this, tool, input, d.title, d.rule, signal);
          return out.allow
            ? { behavior: "allow", updatedInput: input }
            : { behavior: "deny", message: out.message ? `User denied: ${out.message}` : "User denied this action." };
        }
      }
    };

    const claudeMd = join(this.opts.cwd, "CLAUDE.md");
    const projectNotes = existsSync(claudeMd) ? `\n\n# Project CLAUDE.md\n${readFileSync(claudeMd, "utf8")}` : "";

    return {
      cwd: this.opts.cwd,
      model: this.rec.model,
      canUseTool,
      permissionMode: "default" as const,
      // No filesystem settings: user/project allow-rules would bypass the wdash policy. CLAUDE.md is appended instead.
      settingSources: [],
      disallowedTools: DISALLOWED_TOOLS,
      mcpServers: { wdash: this.host.mcpServer(this) },
      systemPrompt: { type: "preset" as const, preset: "claude_code" as const, append: this.opts.systemAppend + projectNotes },
      resume: this.rec.sessionId,
      sessionStore: redisSessionStore(this.host.relay, sessionProjectKey(this.host.jobId, this.id)),
      abortController: this.abort,
      env: { ...process.env, ...this.opts.env },
      stderr: (s: string) => {
        if (/error/i.test(s)) void this.emit("info", { stderr: truncate(s, 2000) });
      },
    };
  }

  private async touch(): Promise<void> {
    this.rec.lastEventAt = Date.now();
  }

  private async emit(type: Parameters<Relay["emit"]>[0]["type"], payload: Record<string, unknown>, sub?: { id?: string; type?: string }): Promise<void> {
    await this.host.relay.emit({ jobId: this.host.jobId, agentId: this.id, subagentId: sub?.id, subagentType: sub?.type, type, payload });
  }

  private async consume(): Promise<void> {
    if (!this.q) return;
    await this.setStatus("running");
    for await (const msg of this.q) {
      this.rec.lastEventAt = Date.now();
      await this.handle(msg);
    }
  }

  private subagentOf(msg: { parent_tool_use_id: string | null; agent_id?: string; subagent_type?: string }) {
    if (msg.agent_id) return { id: msg.agent_id, type: msg.subagent_type };
    if (msg.parent_tool_use_id) return { id: msg.parent_tool_use_id, type: this.subagentCalls.get(msg.parent_tool_use_id) };
    return undefined;
  }

  private async handle(msg: SDKMessage): Promise<void> {
    switch (msg.type) {
      case "system": {
        if (msg.subtype === "init" && msg.session_id && this.rec.sessionId !== msg.session_id) {
          this.rec.sessionId = msg.session_id;
          await this.save();
        }
        return;
      }
      case "assistant": {
        if (this.rec.status !== "running") await this.setStatus("running");
        const sub = this.subagentOf(msg);
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            await this.emit("message", { role: "assistant", text: truncate(block.text, 20_000) }, sub);
          } else if (block.type === "tool_use") {
            if (block.name === "Agent" || block.name === "Task") {
              const input = block.input as { subagent_type?: string; description?: string };
              this.subagentCalls.set(block.id, input.subagent_type ?? "subagent");
            }
            await this.emit("tool_call", { tool: block.name, callId: block.id, input: clip(block.input) }, sub);
          }
        }
        if (msg.error) {
          const usage = msg.error === "rate_limit" || msg.error === "billing_error";
          await this.host.onAgentError(this, usage ? "usage_limit" : "error", `API error: ${msg.error}`);
        }
        return;
      }
      case "user": {
        const sub = this.subagentOf(msg);
        const content = msg.message.content;
        if (typeof content === "string") return;
        for (const block of content) {
          if (block.type === "tool_result") {
            const text =
              typeof block.content === "string"
                ? block.content
                : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
            await this.emit("tool_result", { callId: block.tool_use_id, ok: !block.is_error, output: truncate(text, 6000) }, sub);
          }
        }
        return;
      }
      case "result": {
        this.busy = false;
        this.rec.costUsd = this.baseCostUsd + msg.total_cost_usd;
        await this.save();
        // An assistant-level API error may already have failed this agent; don't raise the same stop twice.
        if ((msg.is_error || msg.subtype !== "success") && this.rec.status !== "failed") {
          const errs = "errors" in msg ? msg.errors.join("\n") : msg.result;
          const usage = USAGE_LIMIT_ERROR_PREFIXES.some((p) => errs.includes(p)) || ("api_error_status" in msg && msg.api_error_status === 429);
          await this.host.onAgentError(this, usage ? "usage_limit" : "error", errs || msg.subtype);
        }
        await this.host.onTurnEnd(this, msg);
        return;
      }
      case "rate_limit_event": {
        await this.host.onRateLimit(msg.rate_limit_info as unknown as Record<string, unknown>);
        return;
      }
      default:
        return;
    }
  }
}

function clip(v: unknown): unknown {
  const s = JSON.stringify(v ?? null);
  return s.length > 4000 ? { truncated: truncate(s, 4000) } : v;
}
