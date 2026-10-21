import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SDKResultMessage, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Redis } from "ioredis";
import {
  ATTACHMENTS_DIR,
  CHAT_AGENT,
  K,
  MODEL_PRESETS,
  TERMINAL_STATUSES,
  branchFor,
  newId,
  truncate,
  type AgentRecord,
  type Approval,
  type Command,
  type JobRecord,
  type ProjectConfig,
  type AttentionReason,
} from "@wdash/shared";
import { AgentRunner, type AgentHost, type ApprovalOutcome } from "./agent.js";
import { chatServer, orchestratorServer, workerServer, type PlannedWorker, type TeamApi } from "./board.js";
import { runChecks, type CheckResult } from "./checks.js";
import { env } from "./config.js";
import * as G from "./git.js";
import { clear, clearJob, raise } from "./notify.js";
import { conflictingClaims, globsOverlap, type PolicyContext } from "./permissions.js";
import { chatPrompt, orchestratorPrompt, workerPrompt } from "./prompts.js";
import type { Relay } from "./relay.js";

export type Mode = "home" | "cloud";
export type JobOutcome = "done" | "failed" | "cancelled" | "lost_lease" | "paused";

type Pending = { resolve: (o: ApprovalOutcome & { answers?: Record<string, string> }) => void; agentId: string; rule?: string; kind: "permission" | "question" };

type WorkerState = {
  rounds: number;
  failedChecks: number;
  lastChecks?: { sha: string; results: CheckResult[] };
  approved: boolean;
  idleNudges: number;
  /** Reported done with passing checks and waiting on the orchestrator's review: don't nudge it. */
  awaitingReview?: boolean;
};

const ORCH = "orchestrator";

export class JobRunner implements AgentHost, TeamApi {
  readonly jobId: string;
  private job!: JobRecord;
  private agents = new Map<string, AgentRunner>();
  private workers = new Map<string, WorkerState>();
  private pending = new Map<string, Pending>();
  private pendingPlan: { summary: string; workers: PlannedWorker[] } | undefined;
  private finalChecks: { sha: string; results: CheckResult[] } | undefined;
  private mainWt = "";
  private finished: ((o: JobOutcome) => void) | undefined;
  private timers: NodeJS.Timeout[] = [];
  private cmdConn: Redis;
  private stopped = false;
  /** Attachment contents already fetched from the relay, by file id. */
  private fileCache = new Map<string, Buffer>();
  private finishing = false;
  private lastCheckpointAt = 0;
  private budgetWarned = false;
  private stallRaised = new Set<string>();

  constructor(
    readonly relay: Relay,
    jobId: string,
    private readonly project: ProjectConfig,
    private readonly mode: Mode,
    /** Repo checkout the worktrees hang off: the user's checkout at home, the cloned repo in the cloud. */
    private readonly repoDir: string,
    private readonly holder: string,
    private readonly agentEnv: Record<string, string | undefined> = {},
  ) {
    this.jobId = jobId;
    this.cmdConn = relay.newBlockingConnection();
  }

  /** The agent the user talks to by default: the orchestrator, or a chat job's single agent. */
  private get lead(): string {
    return this.job?.kind === "chat" ? CHAT_AGENT : ORCH;
  }

  private get stateDir(): string {
    return join(env().WDASH_STATE_DIR, "jobs", this.jobId);
  }

  private wtPath(agentId: string): string {
    return join(env().WDASH_STATE_DIR, "worktrees", this.jobId, agentId);
  }

  // =====================================================================
  // lifecycle
  // =====================================================================

  async run(): Promise<JobOutcome> {
    const job = await this.relay.getJob(this.jobId);
    if (!job) throw new Error(`job ${this.jobId} not found`);
    this.job = job;
    if (TERMINAL_STATUSES.includes(job.status) && job.status !== "failed") return "cancelled";
    if (!(await this.relay.acquireLease(this.jobId, this.holder))) return "lost_lease";

    const done = new Promise<JobOutcome>((res) => (this.finished = res));
    try {
      await this.relay.updateJob(this.jobId, { location: this.mode });
      await this.relay.emit({ jobId: this.jobId, type: "info", payload: { text: `Running on ${this.mode === "home" ? "home PC" : "cloud runner"}` } });
      await clear(this.relay, this.jobId, "pc_offline");
      await clear(this.relay, this.jobId, "cloud_dispatch_failed");

      await this.prepareMain();
      const existing = await this.relay.getAgents(this.jobId);
      if (existing.length) await this.resumeAgents(existing);
      else if (this.job.kind === "chat") await this.startChat();
      else await this.startOrchestrator();

      this.startTimers();
      void this.commandLoop();
    } catch (e) {
      await this.fail(`Setup failed: ${(e as Error).message}`);
    }
    const outcome = await done;
    await this.teardown();
    return outcome;
  }

  private async prepareMain(): Promise<void> {
    if (this.mode === "cloud") await G.fetchAll(this.repoDir);
    const base = await G.baseRef(this.repoDir, this.project.baseBranch, this.mode);
    this.mainWt = await G.addWorktree(this.repoDir, this.wtPath("main"), branchFor.main(this.jobId), base);
    await G.excludeFromGit(this.repoDir, "/.wdash/");
    await this.syncAttachments(this.mainWt);
    await G.pushBranches(this.repoDir, [branchFor.main(this.jobId)]).catch(async (e) => {
      await this.info(`Couldn't push job branch yet (${(e as Error).message.slice(0, 200)}). Cloud failover needs it pushed.`);
    });
  }

  private async startOrchestrator(): Promise<void> {
    const preset = MODEL_PRESETS[this.job.models];
    await this.relay.setStatus(this.jobId, "planning");
    const rec: AgentRecord = {
      id: this.lead,
      role: "orchestrator",
      model: preset.orchestrator,
      name: "orchestrator",
      task: this.job.task,
      globs: [],
      status: "starting",
      reviewRounds: 0,
      lastEventAt: Date.now(),
      costUsd: 0,
      branch: branchFor.main(this.jobId),
    };
    const runner = this.makeRunner(rec, this.mainWt, orchestratorPrompt(this.job, this.project));
    await runner.save();
    const files = (await this.relay.listFiles(this.jobId)).map((f) => f.name);
    const attached = files.length ? `\n\nThe user attached: ${files.join(", ")} (in ${ATTACHMENTS_DIR}/).` : "";
    runner.start(`# Task from the user\n\n${this.job.task}${attached}\n\nStart by exploring the repo, then submit a plan with team_plan.`);
  }

  private async startChat(): Promise<void> {
    await this.relay.setStatus(this.jobId, "running");
    const rec: AgentRecord = {
      id: CHAT_AGENT,
      role: "chat",
      model: this.job.chatModel,
      name: CHAT_AGENT,
      task: this.job.task,
      globs: ["**"],
      status: "starting",
      reviewRounds: 0,
      lastEventAt: Date.now(),
      costUsd: 0,
      branch: branchFor.main(this.jobId),
    };
    await this.relay.setClaims(this.jobId, CHAT_AGENT, ["**"]);
    const runner = this.makeRunner(rec, this.mainWt, chatPrompt(this.job, this.project));
    await runner.save();
    const files = (await this.relay.listFiles(this.jobId)).map((f) => f.name);
    const attached = files.length ? `\n\n[wdash] The user attached: ${files.join(", ")} (in ${ATTACHMENTS_DIR}/).` : "";
    runner.start(`[user] ${this.job.task}${attached}`);
  }

  /** Chat jobs end when the user says so: commit what the agent changed and merge it like a finished job. */
  private async finishChat(): Promise<void> {
    if (this.job.kind !== "chat" || this.finishing) return;
    this.finishing = true;
    await this.agents.get(CHAT_AGENT)?.stop("done");
    await G.checkpointCommit(this.mainWt, "wdash: chat changes");
    const base = await G.baseRef(this.repoDir, this.project.baseBranch, this.mode);
    const d = await G.diffAgainst(this.mainWt, base);
    if (d.files.length) {
      await this.relay.emit({ jobId: this.jobId, agentId: CHAT_AGENT, type: "diff", payload: { branch: branchFor.main(this.jobId), files: d.files, stat: d.stat, patch: d.patch, combined: true } });
    }
    await G.pushBranches(this.repoDir, [branchFor.main(this.jobId)]).catch(() => undefined);
    const summary = d.files.length
      ? `Chat finished. Changed ${d.files.length} file${d.files.length === 1 ? "" : "s"}: ${d.files.map((f) => f.path).slice(0, 10).join(", ")}.`
      : "Chat finished. No file changes.";
    await this.complete(summary);
  }

  private async resumeAgents(recs: AgentRecord[]): Promise<void> {
    const where = this.mode === "cloud" ? "a cloud runner (the home PC went offline)" : "the home PC";
    for (const rec of recs) {
      // Stops raised by the previous runner no longer apply; new ones are raised if they recur.
      await clear(this.relay, this.jobId, "agent_error", rec.id);
      await clear(this.relay, this.jobId, "stalled", rec.id);
      if (rec.role === "worker" && rec.status === "done") {
        // Approved and merged earlier; nothing to resume.
        continue;
      }
      let cwd = this.mainWt;
      if (rec.role === "worker") {
        cwd = await G.addWorktree(this.repoDir, this.wtPath(rec.id), branchFor.worker(this.jobId, rec.id), branchFor.main(this.jobId));
        await this.syncAttachments(cwd);
        this.workers.set(rec.id, { rounds: rec.reviewRounds, failedChecks: 0, approved: false, idleNudges: 0 });
      }
      const prompt =
        rec.role === "orchestrator" ? orchestratorPrompt(this.job, this.project) : rec.role === "chat" ? chatPrompt(this.job, this.project) : workerPrompt(this.job, this.project, rec);
      const runner = this.makeRunner(rec, cwd, prompt);
      runner.start(
        `[wdash] This job was resumed on ${where} from the last checkpoint (${this.job.lastCheckpointSha ?? "start"}). ` +
          `Your working directory is now ${cwd}. Work after the checkpoint may be lost: check git status/diff, then continue.`,
      );
    }
    // Approvals from the previous machine can no longer be answered.
    const all = await this.relay.r.hgetall(K.approvals(this.jobId));
    for (const v of Object.values(all)) {
      const a = JSON.parse(v) as Approval;
      if (a.status === "pending") {
        await this.relay.putApproval({ ...a, status: "expired", decidedAt: Date.now() });
        await clear(this.relay, this.jobId, a.kind === "question" ? "question" : "permission", a.requestId);
      }
    }
    const status = this.job.status === "awaiting_plan_approval" ? "awaiting_plan_approval" : "running";
    await this.relay.setStatus(this.jobId, status);
  }

  private makeRunner(rec: AgentRecord, cwd: string, systemAppend: string): AgentRunner {
    const runner = new AgentRunner(this, rec, { cwd, systemAppend, env: this.agentEnv });
    this.agents.set(rec.id, runner);
    return runner;
  }

  private startTimers(): void {
    this.timers.push(
      setInterval(() => void this.tick().catch((e) => console.error("tick", e)), 10_000),
      setInterval(() => void this.checkStalls().catch((e) => console.error("stall", e)), 60_000),
      setInterval(() => void this.checkpoint("periodic").catch((e) => console.error("checkpoint", e)), 5 * 60_000),
    );
  }

  /** Lease + heartbeat. Losing the lease means another runner took over: stop immediately. */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.mode === "cloud") await this.relay.heartbeatCloud(this.jobId);
    const ok = await this.relay.acquireLease(this.jobId, this.holder);
    if (!ok) {
      console.warn(`[${this.jobId}] lease lost — another runner owns this job now`);
      await this.end("lost_lease", false);
    }
  }

  private async teardown(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.cmdConn.disconnect();
  }

  private async end(outcome: JobOutcome, checkpoint = true): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const p of this.pending.values()) p.resolve({ allow: false, message: "job stopped" });
    this.pending.clear();
    const final = outcome === "done" ? "done" : "stopped";
    const persist = outcome !== "lost_lease";
    await Promise.all([...this.agents.values()].map((a) => a.stop(final, persist).catch(() => undefined)));
    if (checkpoint) await this.checkpoint("final").catch((e) => console.error("final checkpoint", e));
    if (outcome !== "lost_lease") await this.relay.releaseLease(this.jobId, this.holder);
    this.finished?.(outcome);
  }

  private async fail(reason: string): Promise<void> {
    await this.relay.setStatus(this.jobId, "failed", { error: reason });
    await this.notify("job_failed", { detail: reason });
    await this.end("failed");
  }

  // =====================================================================
  // commands from the UI
  // =====================================================================

  private async commandLoop(): Promise<void> {
    let last = this.job.cmdCursor ?? "0-0";
    while (!this.stopped) {
      let cmds: Awaited<ReturnType<Relay["readCommands"]>> = [];
      try {
        cmds = await this.relay.readCommands(this.jobId, last, 5000, this.cmdConn);
      } catch (e) {
        if (this.stopped) return;
        console.error("readCommands", e);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      for (const { id, cmd } of cmds) {
        last = id;
        await this.relay.updateJob(this.jobId, { cmdCursor: id });
        try {
          await this.handleCommand(cmd);
        } catch (e) {
          await this.info(`Command ${cmd.type} failed: ${(e as Error).message}`);
        }
      }
    }
  }

  private async handleCommand(cmd: Command): Promise<void> {
    switch (cmd.type) {
      case "user_message": {
        const target = this.agents.get(cmd.agentId ?? this.lead) ?? this.agents.get(this.lead);
        if (!target) return;
        await this.relay.emit({ jobId: this.jobId, agentId: target.id, type: "message", payload: { role: "user", text: cmd.text } });
        await clear(this.relay, this.jobId, "waiting_for_input", target.id);
        // The agent is blocked on a question: a chat reply is the answer (it can't read new messages until then).
        const question = [...this.pending.entries()].find(([, p]) => p.kind === "question" && p.agentId === target.id);
        if (question && !cmd.attachments?.length) {
          const qs = (((await this.relay.getApproval(this.jobId, question[0]))?.input.questions as Array<{ question: string }> | undefined) ?? []).map((q) => q.question);
          question[1].resolve({ allow: true, answers: Object.fromEntries((qs.length ? qs : ["Question"]).map((q) => [q, cmd.text])) });
          return;
        }
        let note = "";
        if (cmd.attachments?.length) {
          const names = await this.deliverAttachments(cmd.attachments);
          if (names.length) note = `\n\n[wdash] The user attached: ${names.join(", ")} (in ${ATTACHMENTS_DIR}/ in every agent's working directory).`;
        }
        target.send(`[user] ${cmd.text}${note}`);
        // Show it as working right away, not only once its first reply streams in.
        if (target.rec.status === "idle") await target.setStatus("running");
        return;
      }
      case "decide": {
        const p = this.pending.get(cmd.requestId);
        if (!p || p.kind !== "permission") return;
        if (cmd.allow && cmd.scope === "job" && p.rule) await this.relay.addAllowRule(this.jobId, p.rule);
        p.resolve({ allow: cmd.allow, message: cmd.message, scope: cmd.scope });
        return;
      }
      case "answer": {
        const p = this.pending.get(cmd.requestId);
        if (!p || p.kind !== "question") return;
        p.resolve({ allow: true, answers: cmd.answers });
        return;
      }
      case "approve_plan": {
        if (!this.pendingPlan) return;
        await clear(this.relay, this.jobId, "plan_approval");
        if (cmd.edits?.trim()) {
          await this.relay.setStatus(this.jobId, "planning");
          this.agents.get(this.lead)?.send(`[user] The user edited your plan:\n${cmd.edits}\n\nRevise it and call team_plan again.`);
          this.pendingPlan = undefined;
          return;
        }
        const plan = this.pendingPlan;
        this.pendingPlan = undefined;
        await this.launchPlan(plan.workers);
        this.agents.get(this.lead)?.send("[wdash] The user approved your plan. Workers are starting now.");
        return;
      }
      case "cancel": {
        await this.relay.setStatus(this.jobId, "cancelled");
        await clearJob(this.relay, this.jobId);
        await this.end("cancelled");
        return;
      }
      case "set_auto_mode": {
        // The web app already saved the flag on the job; allow whatever is waiting right now.
        if (!cmd.enabled) return;
        for (const p of [...this.pending.values()]) if (p.kind === "permission") p.resolve({ allow: true, scope: "once" });
        return;
      }
      case "finish_chat": {
        await this.finishChat();
        return;
      }
      case "pause": {
        await Promise.all([...this.agents.values()].map((a) => a.interrupt()));
        await this.relay.setStatus(this.jobId, "paused");
        return;
      }
      case "resume": {
        await clear(this.relay, this.jobId, "usage_limit");
        await this.relay.setStatus(this.jobId, "running");
        for (const a of this.agents.values()) {
          if (["failed", "stopped", "idle", "running"].includes(a.rec.status) && !(a.rec.role === "worker" && this.workers.get(a.id)?.approved)) {
            if (a.rec.status === "failed") await a.restart("[wdash] Resuming after an error. Check where you were and continue.");
            else a.send("[wdash] The user resumed the job. Continue where you left off.");
          }
        }
        return;
      }
      case "raise_budget": {
        this.job.budgetUsd = cmd.budgetUsd;
        this.budgetWarned = false;
        await this.relay.updateJob(this.jobId, { budgetUsd: cmd.budgetUsd });
        await clear(this.relay, this.jobId, "over_budget");
        await clear(this.relay, this.jobId, "budget_warning");
        if (this.job.status === "over_budget") await this.handleCommand({ type: "resume" });
        return;
      }
      case "retry_agent": {
        const a = this.agents.get(cmd.agentId);
        if (!a) return;
        await clear(this.relay, this.jobId, "agent_error", a.id);
        await clear(this.relay, this.jobId, "stalled", a.id);
        await a.restart("[wdash] You were restarted by the user. Check your state (git status) and continue your task.");
        return;
      }
      case "nudge": {
        const a = this.agents.get(cmd.agentId);
        if (!a) return;
        await clear(this.relay, this.jobId, "stalled", a.id);
        if (a.busy) await a.interrupt();
        a.send(`[user] ${cmd.text ?? "Status check: you seem stuck. Summarize where you are and continue."}`);
        return;
      }
      case "accept_review": {
        await clear(this.relay, this.jobId, "review_cap", cmd.agentId);
        await clear(this.relay, this.jobId, "checks_failing", cmd.agentId);
        const msg = await this.mergeWorker(cmd.agentId, true);
        this.agents.get(this.lead)?.send(`[user] The user accepted ${cmd.agentId}'s work as-is. ${msg}`);
        return;
      }
      case "guidance": {
        const a = this.agents.get(cmd.agentId);
        const ws = this.workers.get(cmd.agentId);
        if (ws) ws.rounds = Math.min(ws.rounds, this.job.reviewCap - 1);
        if (ws) ws.failedChecks = 0;
        await clear(this.relay, this.jobId, "review_cap", cmd.agentId);
        await clear(this.relay, this.jobId, "checks_failing", cmd.agentId);
        a?.send(`[user guidance] ${cmd.text}`);
        this.agents.get(this.lead)?.send(`[wdash] The user gave ${cmd.agentId} guidance: ${cmd.text}`);
        return;
      }
    }
  }

  // =====================================================================
  // AgentHost
  // =====================================================================

  async policyContext(agent: AgentRunner): Promise<PolicyContext> {
    const [claims, rules] = await Promise.all([this.relay.getClaims(this.jobId), this.relay.getAllowRules(this.jobId)]);
    const owned = Object.entries(claims)
      .filter(([, owner]) => owner === agent.id)
      .map(([g]) => g);
    return {
      role: agent.rec.role,
      agentId: agent.id,
      root: agent.cwd,
      owned,
      claims,
      commands: this.project.commands,
      jobRules: rules,
    };
  }

  async requestPermission(agent: AgentRunner, tool: string, input: Record<string, unknown>, title: string, rule: string, signal: AbortSignal): Promise<ApprovalOutcome> {
    // Read fresh: the user can flip auto mode while the job runs.
    if ((await this.relay.getJob(this.jobId))?.autoMode) {
      await this.relay.emit({ jobId: this.jobId, agentId: agent.id, type: "permission_decision", payload: { allow: true, auto: true, tool, title } });
      return { allow: true, scope: "once" };
    }
    const out = await this.waitForUser(agent, "permission", tool, input, title, rule, signal);
    return out;
  }

  async askQuestion(agent: AgentRunner, input: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, string> | undefined> {
    const qs = (input.questions as Array<{ question: string }> | undefined) ?? [];
    const title = qs.map((q) => q.question).join(" / ") || "Question";
    const out = await this.waitForUser(agent, "question", "AskUserQuestion", input, title, undefined, signal);
    return out.allow ? out.answers : undefined;
  }

  private async waitForUser(
    agent: AgentRunner,
    kind: "permission" | "question",
    tool: string,
    input: Record<string, unknown>,
    title: string,
    rule: string | undefined,
    signal: AbortSignal,
  ): Promise<ApprovalOutcome & { answers?: Record<string, string> }> {
    const requestId = newId("rq");
    const approval: Approval = { requestId, jobId: this.jobId, agentId: agent.id, kind, tool, input, title, status: "pending", createdAt: Date.now() };
    await this.relay.putApproval(approval);
    await this.relay.emit({
      jobId: this.jobId,
      agentId: agent.id,
      type: kind === "permission" ? "permission_request" : "question",
      payload: { requestId, tool, input, title },
    });
    const prevStatus = agent.rec.status;
    await agent.setStatus(kind === "permission" ? "waiting_on_approval" : "waiting_on_user");
    const reason: AttentionReason = kind === "permission" ? "permission" : "question";
    await this.notify(reason, { agentId: agent.id, ref: requestId, detail: title });

    const outcome = await new Promise<ApprovalOutcome & { answers?: Record<string, string> }>((resolve) => {
      this.pending.set(requestId, { resolve, agentId: agent.id, rule, kind });
      signal.addEventListener("abort", () => resolve({ allow: false, message: "aborted" }), { once: true });
    });
    this.pending.delete(requestId);

    const status = kind === "question" ? (outcome.answers ? "answered" : "denied") : outcome.allow ? "allowed" : "denied";
    await this.relay.putApproval({ ...approval, status, decidedAt: Date.now() });
    await this.relay.emit({ jobId: this.jobId, agentId: agent.id, type: "permission_decision", payload: { requestId, allow: outcome.allow, answers: outcome.answers } });
    await clear(this.relay, this.jobId, reason, requestId);
    if (!this.stopped) await agent.setStatus(prevStatus === "waiting_on_approval" || prevStatus === "waiting_on_user" ? "running" : prevStatus);
    return outcome;
  }

  async onTurnEnd(agent: AgentRunner, result: SDKResultMessage): Promise<void> {
    if (this.stopped) return;
    await this.recordUsage(agent, result);
    if (!result.is_error && agent.rec.status === "running") await agent.setStatus("idle");
    if (Date.now() - this.lastCheckpointAt > 60_000) await this.checkpoint("turn").catch((e) => console.error("checkpoint", e));
    if (await this.checkBudget()) return;

    if (agent.rec.role === "worker") {
      const ws = this.workers.get(agent.id);
      if (ws && !ws.approved && !ws.awaitingReview && agent.rec.status === "idle") {
        // A worker that stops without reporting done gets one automatic nudge, then the orchestrator decides.
        if (ws.idleNudges < 1) {
          ws.idleNudges++;
          agent.send("[wdash] You ended your turn without calling board_report_done. If you're finished, report done; if you're blocked, message the orchestrator with board_post.");
        } else {
          this.agents.get(this.lead)?.send(`[wdash] Worker ${agent.id} stopped without reporting done. Its last message: ${truncate(resultText(result), 1500)}`);
        }
      }
    }
    await this.checkWaitingForUser(result);
  }

  /** The job is stuck on the user if the orchestrator is idle and nobody else is working. */
  private async checkWaitingForUser(result?: SDKResultMessage): Promise<void> {
    const orch = this.agents.get(this.lead);
    if (!orch || orch.rec.status !== "idle" || this.pendingPlan || this.finishing || this.stopped) return;
    const others = [...this.agents.values()].filter((a) => a.id !== this.lead);
    const activeWorker = others.some((a) => ["running", "starting", "reviewing", "waiting_on_approval", "waiting_on_user"].includes(a.rec.status));
    if (activeWorker || this.pending.size) return;
    if (TERMINAL_STATUSES.includes(this.job.status)) return;
    await this.relay.setStatus(this.jobId, "waiting_on_user");
    this.job.status = "waiting_on_user";
    await this.notify("waiting_for_input", {
      agentId: this.lead,
      detail: result ? truncate(resultText(result), 600) : "The orchestrator stopped and nothing else is running.",
    });
  }

  async onAgentError(agent: AgentRunner, kind: "usage_limit" | "error", detail: string): Promise<void> {
    if (this.stopped) return;
    await this.relay.emit({ jobId: this.jobId, agentId: agent.id, type: "error", payload: { kind, detail: truncate(detail, 3000) } });
    if (kind === "usage_limit") {
      await this.relay.setStatus(this.jobId, "paused");
      await this.notify("usage_limit", { agentId: agent.id, detail: truncate(detail, 500) });
      return;
    }
    await agent.setStatus("failed");
    await this.notify("agent_error", { agentId: agent.id, detail: truncate(detail, 500) });
  }

  async onRateLimit(info: Record<string, unknown>): Promise<void> {
    const type = String(info.rateLimitType ?? "default");
    await this.relay.r.hset(K.rateLimit, type, JSON.stringify({ ...info, updatedAt: Date.now() }));
    if (info.status === "rejected") {
      await this.relay.setStatus(this.jobId, "paused");
      const resets = typeof info.resetsAt === "number" ? ` Resets ${new Date(info.resetsAt * 1000).toLocaleString()}.` : "";
      await this.notify("usage_limit", { detail: `Subscription limit (${type}) reached.${resets}` });
    }
  }

  mcpServer(agent: AgentRunner): McpSdkServerConfigWithInstance {
    if (agent.rec.role === "chat") return chatServer();
    return agent.rec.role === "orchestrator" ? orchestratorServer(this, agent.id) : workerServer(this, agent.id);
  }

  // =====================================================================
  // TeamApi (board tools)
  // =====================================================================

  async post(fromId: string, to: string, text: string): Promise<string> {
    const targets = to === "all" ? [...this.agents.values()].filter((a) => a.id !== fromId) : [this.agents.get(to)].filter((a): a is AgentRunner => !!a);
    if (!targets.length) throw new Error(`No agent named '${to}'. Agents: ${[...this.agents.keys()].join(", ")}`);
    await this.relay.r.xadd(K.board(this.jobId), "MAXLEN", "~", "5000", "*", "m", JSON.stringify({ ts: Date.now(), from: fromId, to, text }));
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "board", payload: { from: fromId, to, text } });
    for (const t of targets) {
      if (t.rec.status === "done" || t.rec.status === "stopped") continue;
      t.send(`[board] from ${fromId}: ${text}`);
    }
    return `Delivered to ${targets.map((t) => t.id).join(", ")}.`;
  }

  async submitPlan(summary: string, workers: PlannedWorker[]): Promise<string> {
    const fixed = this.job.workers === "auto" ? undefined : Number(this.job.workers);
    if (fixed && workers.length !== fixed) throw new Error(`The user asked for exactly ${fixed} worker(s); your plan has ${workers.length}.`);
    const names = new Set<string>();
    for (const w of workers) {
      if (names.has(w.name) || w.name === ORCH || w.name === "main" || this.agents.has(w.name)) throw new Error(`Duplicate or reserved worker name: ${w.name}`);
      names.add(w.name);
    }
    for (let i = 0; i < workers.length; i++)
      for (let j = i + 1; j < workers.length; j++)
        for (const a of workers[i]!.globs)
          for (const b of workers[j]!.globs)
            if (globsOverlap(a, b)) throw new Error(`Ownership overlaps: ${workers[i]!.name}:${a} vs ${workers[j]!.name}:${b}. Make the globs disjoint.`);

    await this.relay.emit({ jobId: this.jobId, agentId: this.lead, type: "plan", payload: { summary, workers } });
    if (workers.length >= 3) {
      this.pendingPlan = { summary, workers };
      await this.relay.setStatus(this.jobId, "awaiting_plan_approval");
      const detail = `${summary}\n\n${workers.map((w) => `• ${w.name} — ${w.globs.join(", ")}`).join("\n")}`;
      await this.notify("plan_approval", { agentId: this.lead, detail: truncate(detail, 800) });
      return "Plan submitted. It has 3+ workers, so it waits for the user's approval. End your turn now; you'll get a message when it's approved or edited.";
    }
    await this.launchPlan(workers);
    return `Plan accepted. Started workers: ${workers.map((w) => w.name).join(", ")}. End your turn; you'll be messaged when they report done or need you.`;
  }

  private async launchPlan(workers: PlannedWorker[]): Promise<void> {
    await this.relay.setStatus(this.jobId, "running");
    for (const w of workers) await this.spawnWorker(w);
  }

  async spawnWorker(w: PlannedWorker): Promise<string> {
    if (this.agents.has(w.name)) throw new Error(`Worker ${w.name} already exists.`);
    const conflicts = conflictingClaims(await this.relay.getClaims(this.jobId), w.globs, w.name);
    if (conflicts.length) throw new Error(`Ownership conflicts: ${conflicts.join("; ")}`);
    const preset = MODEL_PRESETS[this.job.models];
    const branch = branchFor.worker(this.jobId, w.name);
    const cwd = await G.addWorktree(this.repoDir, this.wtPath(w.name), branch, branchFor.main(this.jobId));
    await this.syncAttachments(cwd);
    const rec: AgentRecord = {
      id: w.name,
      role: "worker",
      model: preset.worker,
      name: w.name,
      task: w.task,
      globs: w.globs,
      status: "starting",
      branch,
      reviewRounds: 0,
      lastEventAt: Date.now(),
      costUsd: 0,
    };
    await this.relay.setClaims(this.jobId, w.name, w.globs);
    this.workers.set(w.name, { rounds: 0, failedChecks: 0, approved: false, idleNudges: 0 });
    const runner = this.makeRunner(rec, cwd, workerPrompt(this.job, this.project, rec));
    await runner.save();
    runner.start(`# Your task\n\n${w.task}\n\nYou own: ${w.globs.join(", ")}. When finished, call board_report_done.`);
    return `Spawned ${w.name}.`;
  }

  async grantFiles(agentId: string, globs: string[]): Promise<string> {
    const a = this.agents.get(agentId);
    if (!a || a.rec.role !== "worker") throw new Error(`No worker ${agentId}`);
    const conflicts = conflictingClaims(await this.relay.getClaims(this.jobId), globs, agentId);
    if (conflicts.length) throw new Error(`Can't grant, already owned: ${conflicts.join("; ")}`);
    await this.relay.setClaims(this.jobId, agentId, globs);
    a.rec.globs = [...new Set([...a.rec.globs, ...globs])];
    await a.save();
    a.send(`[board] from orchestrator: You now also own ${globs.join(", ")}.`);
    return `Granted ${globs.join(", ")} to ${agentId}.`;
  }

  async denyFiles(agentId: string, reason: string): Promise<string> {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`No agent ${agentId}`);
    a.send(`[board] from orchestrator: File request denied: ${reason}`);
    return "Denied.";
  }

  async requestFiles(fromId: string, globs: string[], reason: string): Promise<string> {
    const claims = await this.relay.getClaims(this.jobId);
    const conflicts = conflictingClaims(claims, globs, fromId);
    const note = conflicts.length ? ` Note: overlaps existing claims: ${conflicts.join("; ")}.` : "";
    this.agents.get(this.lead)?.send(`[board] from ${fromId}: requests files ${globs.join(", ")} — ${reason}.${note} Use board_grant_files or board_deny_files.`);
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "board", payload: { from: fromId, to: this.lead, text: `Requests files ${globs.join(", ")}: ${reason}` } });
    return "Request sent to the orchestrator. Work on something else or end your turn until you hear back.";
  }

  async reportDone(fromId: string, summary: string): Promise<string> {
    const a = this.agents.get(fromId);
    const ws = this.workers.get(fromId);
    if (!a || !ws) throw new Error("Only workers can report done.");
    await G.checkpointCommit(a.cwd, `wdash: ${fromId} done — ${summary.slice(0, 60)}`);
    const sha = await G.head(a.cwd);
    await a.setStatus("reviewing");
    const results = await runChecks(this.project, a.cwd, this.stateDir);
    ws.lastChecks = { sha, results };
    const passed = checksPass(results);
    ws.failedChecks = passed ? 0 : ws.failedChecks + 1;
    ws.awaitingReview = passed;
    await this.emitChecks(fromId, results, "worker");
    if (!passed && ws.failedChecks >= 2) {
      await this.notify("checks_failing", { agentId: fromId, detail: checksSummary(results) });
    }
    this.agents.get(this.lead)?.send(
      `[board] ${fromId} reports done: ${summary}\nChecks at ${sha.slice(0, 8)}: ${checksSummary(results)}\nReview with review_diff, then board_approve or board_request_changes.`,
    );
    return passed
      ? "Reported. Checks passed. The orchestrator will review; end your turn now."
      : `Reported, but checks FAILED: ${checksSummary(results)}. Fix them now unless the orchestrator tells you otherwise.`;
  }

  async reviewDiff(agentId: string): Promise<string> {
    const a = this.agents.get(agentId);
    if (!a || a.rec.role !== "worker") throw new Error(`No worker ${agentId}`);
    const d = await G.diffAgainst(a.cwd, branchFor.main(this.jobId));
    await this.relay.emit({ jobId: this.jobId, agentId, type: "diff", payload: { branch: a.rec.branch, files: d.files, stat: d.stat, patch: d.patch } });
    const ws = this.workers.get(agentId);
    const checks = ws?.lastChecks ? `Checks at ${ws.lastChecks.sha.slice(0, 8)}: ${checksSummary(ws.lastChecks.results)}` : "No checks run yet.";
    return `${checks}\nReview round ${ws?.rounds ?? 0}/${this.job.reviewCap}\n\n${d.stat}\n\n${truncate(d.patch, 60_000)}`;
  }

  async requestChanges(agentId: string, notes: string): Promise<string> {
    const a = this.agents.get(agentId);
    const ws = this.workers.get(agentId);
    if (!a || !ws) throw new Error(`No worker ${agentId}`);
    ws.rounds++;
    a.rec.reviewRounds = ws.rounds;
    await a.save();
    await this.relay.emit({ jobId: this.jobId, agentId, type: "review", payload: { worker: agentId, round: ws.rounds, verdict: "changes_requested", notes } });
    if (ws.rounds > this.job.reviewCap) {
      await this.notify("review_cap", { agentId, detail: `After ${this.job.reviewCap} rounds: ${truncate(notes, 500)}` });
      return `Review cap (${this.job.reviewCap}) reached. The user has been asked to accept, guide, or cancel. Don't review ${agentId} again until you hear back.`;
    }
    ws.idleNudges = 0;
    ws.awaitingReview = false;
    await a.setStatus("running");
    a.send(`[review round ${ws.rounds}/${this.job.reviewCap}] The orchestrator requests changes:\n${notes}\n\nFix them and call board_report_done again.`);
    return `Sent back to ${agentId} (round ${ws.rounds}/${this.job.reviewCap}).`;
  }

  async approve(agentId: string): Promise<string> {
    const a = this.agents.get(agentId);
    const ws = this.workers.get(agentId);
    if (!a || !ws) throw new Error(`No worker ${agentId}`);
    const sha = await G.head(a.cwd);
    if (!ws.lastChecks || ws.lastChecks.sha !== sha) throw new Error(`${agentId} has no check results for its current commit. Ask it to board_report_done.`);
    if (!checksPass(ws.lastChecks.results)) throw new Error(`Checks are failing for ${agentId}: ${checksSummary(ws.lastChecks.results)}. Request changes instead.`);
    await this.relay.emit({ jobId: this.jobId, agentId, type: "review", payload: { worker: agentId, round: ws.rounds, verdict: "approved" } });
    return this.mergeWorker(agentId, false);
  }

  private async mergeWorker(agentId: string, forced: boolean): Promise<string> {
    const a = this.agents.get(agentId);
    const ws = this.workers.get(agentId);
    if (!a || !ws) throw new Error(`No worker ${agentId}`);
    await G.checkpointCommit(a.cwd, `wdash: ${agentId} final`);
    const res = await G.mergeInto(this.mainWt, a.rec.branch!, `wdash: merge ${agentId}${forced ? " (accepted by user)" : ""}`);
    if (!res.ok) {
      return `Merge conflict merging ${agentId}: ${res.conflicts.join(", ")}. Ask ${agentId} to call sync_with_main and resolve, then report done again.`;
    }
    ws.approved = true;
    await a.stop("done");
    this.finalChecks = undefined;
    await this.checkpoint("merge");
    const left = [...this.workers.entries()].filter(([, s]) => !s.approved).map(([n]) => n);
    return `Merged ${agentId} into the job branch. ${left.length ? `Still open: ${left.join(", ")}.` : "All workers merged: run job_final_check, review the combined result, then job_finish."}`;
  }

  async syncWithMain(fromId: string): Promise<string> {
    const a = this.agents.get(fromId);
    if (!a) throw new Error("unknown agent");
    await G.checkpointCommit(a.cwd, `wdash: ${fromId} before sync`);
    const res = await G.mergeInto(a.cwd, branchFor.main(this.jobId), "wdash: sync with job branch");
    if (res.ok) return "Merged the job branch into yours.";
    return `Conflicts in ${res.conflicts.join(", ")}; the merge was aborted. Ask the orchestrator for help or for ownership of those files.`;
  }

  async finalCheck(): Promise<string> {
    await this.relay.setStatus(this.jobId, "reviewing");
    const results = await runChecks(this.project, this.mainWt, this.stateDir);
    const sha = await G.head(this.mainWt);
    this.finalChecks = { sha, results };
    await this.emitChecks(this.lead, results, "final");
    const d = await G.diffAgainst(this.mainWt, await G.baseRef(this.repoDir, this.project.baseBranch, this.mode));
    await this.relay.emit({ jobId: this.jobId, agentId: this.lead, type: "diff", payload: { branch: branchFor.main(this.jobId), files: d.files, stat: d.stat, patch: d.patch, combined: true } });
    await this.relay.setStatus(this.jobId, "running");
    return `Final checks at ${sha.slice(0, 8)}: ${checksSummary(results)}\n\nCombined diff:\n${d.stat}\n\n${truncate(d.patch, 60_000)}`;
  }

  async finish(summary: string): Promise<string> {
    const open = [...this.workers.entries()].filter(([, s]) => !s.approved).map(([n]) => n);
    if (open.length) throw new Error(`Workers not merged yet: ${open.join(", ")}.`);
    const sha = await G.head(this.mainWt);
    if (!this.finalChecks || this.finalChecks.sha !== sha) throw new Error("Run job_final_check on the current job branch first.");
    if (!checksPass(this.finalChecks.results)) throw new Error(`Final checks failing: ${checksSummary(this.finalChecks.results)}`);
    // Finish asynchronously so this tool call can return to the model before agents are stopped.
    // Until then the orchestrator's turn end must not mark the job as waiting on the user.
    this.finishing = true;
    setTimeout(() => void this.complete(summary).catch((e) => this.fail(`Finishing failed: ${(e as Error).message}`)), 50);
    return "Finishing the job. Thanks — you can stop now.";
  }

  private async complete(summary: string): Promise<void> {
    await this.relay.setStatus(this.jobId, "merging", { summary });
    await this.checkpoint("final");
    let mergeState: JobRecord["mergeState"] = "pending";
    let detail = summary;
    if (this.mode === "home" && this.project.localPath) {
      const out = await G.syncIntoCheckout(this.project.localPath, this.project.baseBranch, this.jobId);
      if (out.kind === "merged") {
        mergeState = "merged";
        detail = `${summary}\n\nMerged into ${this.project.baseBranch} on your PC.`;
      } else if (out.kind === "needs_merge") {
        mergeState = "needs_merge";
        await this.notify("needs_merge", { detail: `${out.why}${out.conflicts?.length ? ` Conflicts: ${out.conflicts.join(", ")}` : ""}` });
      }
    } else {
      await this.relay.r.zadd(K.mergeQueue, Date.now(), this.jobId);
      detail = `${summary}\n\nIt will merge into your PC's checkout when the PC is back online.`;
    }
    await this.relay.updateJob(this.jobId, { mergeState });
    await this.relay.setStatus(this.jobId, "done", { summary });
    await clearJob(this.relay, this.jobId, ["needs_merge"]);
    await this.notify("job_finished", { detail: truncate(detail, 600) });
    await this.end("done", false);
  }

  // =====================================================================
  // budget, usage, stalls, checkpoints
  // =====================================================================

  private async recordUsage(agent: AgentRunner, r: SDKResultMessage): Promise<void> {
    const u = r.usage as unknown as Record<string, number>;
    await this.relay.r.hset(
      K.usage(this.jobId),
      agent.id,
      JSON.stringify({
        costUsd: r.total_cost_usd,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        turns: r.num_turns,
        model: agent.rec.model,
      }),
    );
    const total = [...this.agents.values()].reduce((s, a) => s + (a.rec.costUsd || 0), 0);
    this.job.costUsd = total;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const v of Object.values(await this.relay.r.hgetall(K.usage(this.jobId)))) {
      const x = JSON.parse(v) as Record<string, number>;
      tokensIn += (x.inputTokens ?? 0) + (x.cacheReadTokens ?? 0) + (x.cacheWriteTokens ?? 0);
      tokensOut += x.outputTokens ?? 0;
    }
    await this.relay.updateJob(this.jobId, { costUsd: total.toFixed(4), tokensIn, tokensOut });
    await this.relay.emit({ jobId: this.jobId, agentId: agent.id, type: "usage", payload: { agent: agent.id, costUsd: r.total_cost_usd, jobCostUsd: total } });
  }

  /** Returns true if the job was stopped for budget. */
  private async checkBudget(): Promise<boolean> {
    const { costUsd, budgetUsd } = this.job;
    if (costUsd >= budgetUsd && this.job.status !== "over_budget") {
      await Promise.all([...this.agents.values()].map((a) => a.interrupt()));
      this.job.status = "over_budget";
      await this.relay.setStatus(this.jobId, "over_budget");
      await this.checkpoint("budget");
      await this.notify("over_budget", { detail: `Spent ~$${costUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} (API-equivalent).` });
      return true;
    }
    if (!this.budgetWarned && costUsd >= 0.8 * budgetUsd) {
      this.budgetWarned = true;
      await this.notify("budget_warning", { detail: `~$${costUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} used.` });
    }
    return this.job.status === "over_budget";
  }

  private async checkStalls(): Promise<void> {
    const limit = env().WDASH_STALL_MINUTES * 60_000;
    for (const a of this.agents.values()) {
      const stalled = a.rec.status === "running" && Date.now() - a.rec.lastEventAt > limit;
      if (stalled && !this.stallRaised.has(a.id)) {
        this.stallRaised.add(a.id);
        await this.notify("stalled", { agentId: a.id, detail: `No activity for ${Math.round((Date.now() - a.rec.lastEventAt) / 60_000)} min.` });
      } else if (!stalled && this.stallRaised.has(a.id)) {
        this.stallRaised.delete(a.id);
        await clear(this.relay, this.jobId, "stalled", a.id);
      }
      await a.save();
    }
  }

  /** Commit WIP everywhere and push all job branches so another machine can take over (SPEC.md §10). */
  private async checkpoint(why: string): Promise<void> {
    this.lastCheckpointAt = Date.now();
    const branches = [branchFor.main(this.jobId)];
    for (const a of this.agents.values()) {
      // A chat agent edits the job branch itself, so its work is checkpointed there.
      if (a.rec.role === "chat") await G.checkpointCommit(a.cwd, `wdash: checkpoint (${why})`).catch(() => undefined);
      if (a.rec.role !== "worker") continue;
      branches.push(a.rec.branch!);
      await G.checkpointCommit(a.cwd, `wdash: checkpoint (${why})`).catch(() => undefined);
    }
    const sha = await G.head(this.mainWt);
    try {
      await G.pushBranches(this.repoDir, branches);
    } catch (e) {
      await this.info(`Checkpoint push failed: ${(e as Error).message.slice(0, 300)}`);
      return;
    }
    await this.relay.updateJob(this.jobId, { lastCheckpointSha: sha });
    await this.relay.emit({ jobId: this.jobId, type: "checkpoint", payload: { sha, why, branches } });
  }

  // =====================================================================
  // helpers
  // =====================================================================

  private async notify(reason: AttentionReason, ctx: { agentId?: string; ref?: string; detail?: string }): Promise<void> {
    const name = ctx.agentId ? (ctx.agentId === ORCH ? "Orchestrator" : ctx.agentId === CHAT_AGENT ? "Claude" : `Worker ${ctx.agentId}`) : undefined;
    await raise(this.relay, reason, { jobId: this.jobId, agentName: name, ...ctx });
  }

  private async info(text: string): Promise<void> {
    await this.relay.emit({ jobId: this.jobId, type: "info", payload: { text } });
  }

  // =====================================================================
  // attachments
  // =====================================================================

  /** Writes every job attachment into `cwd`'s attachments dir (git-excluded). Returns the names written. */
  private async syncAttachments(cwd: string, only?: Set<string>): Promise<string[]> {
    const files = (await this.relay.listFiles(this.jobId)).filter((f) => !only || only.has(f.id));
    if (!files.length) return [];
    const dir = join(cwd, ATTACHMENTS_DIR);
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const target = join(dir, f.name);
      if (existsSync(target)) continue;
      let data = this.fileCache.get(f.id);
      if (!data) {
        data = await this.relay.getFileData(this.jobId, f.id);
        if (!data) {
          await this.info(`Attachment ${f.name} is missing from storage; skipped.`);
          continue;
        }
        this.fileCache.set(f.id, data);
      }
      writeFileSync(target, data);
    }
    return files.map((f) => f.name);
  }

  /** Files added mid-job: copy them into every live agent's worktree. */
  private async deliverAttachments(ids: string[]): Promise<string[]> {
    const only = new Set(ids);
    const cwds = new Set([this.mainWt, ...[...this.agents.values()].map((a) => a.cwd)]);
    let names: string[] = [];
    for (const cwd of cwds) names = await this.syncAttachments(cwd, only);
    return names;
  }

  private async emitChecks(agentId: string, results: CheckResult[], scope: "worker" | "final"): Promise<void> {
    for (const r of results) {
      if (r.pngBase64 && r.pngBase64.length < 1_500_000) {
        await this.relay.emit({ jobId: this.jobId, agentId, type: "artifact", payload: { kind: "screenshot", scope, png: r.pngBase64 } });
      }
    }
    await this.relay.emit({
      jobId: this.jobId,
      agentId,
      type: "review",
      payload: { worker: agentId, scope, verdict: "checks", checks: results.map(({ pngBase64: _p, ...r }) => r) },
    });
  }
}

function checksPass(results: CheckResult[]): boolean {
  return results.every((r) => r.ok);
}

function checksSummary(results: CheckResult[]): string {
  return results.map((r) => `${r.name} ${r.skipped ? "skipped" : r.ok ? "passed" : `FAILED\n${truncate(r.output, 2500)}`}`).join("; ");
}

function resultText(r: SDKResultMessage): string {
  return "result" in r && typeof r.result === "string" ? r.result : "";
}
