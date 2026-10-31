import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { SDKResultMessage, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { Redis } from "ioredis";
import {
  ATTACHMENTS_DIR,
  CHAT_AGENT,
  CacheEntry,
  MAX_WORKERS,
  NO_PROJECT,
  MAX_SHARE_BYTES,
  MAX_ATTACHMENTS,
  safeFileName,
  uniqueFileName,
  K,
  MODEL_PRESETS,
  TERMINAL_STATUSES,
  branchFor,
  newId,
  kaggleHours,
  truncate,
  type AgentRecord,
  type Approval,
  type Command,
  type JobRecord,
  type KaggleAccel,
  type KaggleSession,
  type ProjectConfig,
  type AttentionReason,
} from "@wdash/shared";
import { AgentRunner, type AgentHost, type ApprovalOutcome } from "./agent.js";
import { chatServer, leadServer, orchestratorServer, workerServer, type PlannedWorker, type TeamApi } from "./board.js";
import { runChecks, type CheckResult } from "./checks.js";
import { env } from "./config.js";
import * as G from "./git.js";
import { ensureKaggleFor, isKaggleModel, kaggleModelName } from "./kaggle.js";
import { clear, clearJob, raise } from "./notify.js";
import { conflictingClaims, globsOverlap, inside, type PolicyContext } from "./permissions.js";
import { OTHER_REPOS_DIR, openRepo, pushRepo } from "./otherRepos.js";
import { vercelConfigured, vercelDeploy, vercelProjectName } from "./vercel.js";
import { chatPrompt, leadPrompt, orchestratorPrompt, workerPrompt } from "./prompts.js";
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
  startedAt?: number;
  /** The orchestrator was already asked to add helpers for this worker. */
  helpAsked?: boolean;
  /** Set on a helper: the slow worker it took work from. */
  helps?: string;
  /** Who reviews and merges it: the orchestrator, or (3-tier) the lead it works under. */
  parent: string;
};

/** Workers and leads both have their own branch, get reviewed, and are merged by their parent. */
function isTeamMember(role: string): boolean {
  return role === "worker" || role === "lead";
}

/** At most this many helpers per slow worker. */
const MAX_HELPERS = 5;

const ORCH = "orchestrator";

/** `apiMs`: time spent waiting on the model, for output tokens per second. */
type UsageTotals = { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; turns: number; apiMs?: number };

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
  /** Each agent's usage totals from earlier runs, read once per run. */
  private usageBase = new Map<string, UsageTotals>();
  /** This run's totals at an agent's previous result, so each turn's own speed can be measured. */
  private lastRun = new Map<string, { out: number; apiMs: number }>();
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

  // ---- 3-tier: every worker or lead has a parent (the orchestrator or a lead) that reviews and merges it.

  private parentOf(id: string): string {
    return this.workers.get(id)?.parent ?? this.agents.get(id)?.rec.parent ?? ORCH;
  }

  /** The branch an agent starts from, syncs with and is diffed against: the job branch, or its lead's. */
  private parentBranch(id: string): string {
    const p = this.parentOf(id);
    return p === ORCH ? branchFor.main(this.jobId) : (this.agents.get(p)?.rec.branch ?? branchFor.worker(this.jobId, p));
  }

  /** The worktree an agent's approved work is merged into. */
  private parentWorktree(id: string): string {
    const p = this.parentOf(id);
    if (p === ORCH) return this.mainWt;
    const lead = this.agents.get(p);
    if (!lead) throw new Error(`Lead ${p} isn't running.`);
    return lead.cwd;
  }

  /** Only an agent's own parent may review, approve, or send it back. */
  private assertParent(agentId: string, by: string): void {
    if (this.parentOf(agentId) !== by) throw new Error(`${agentId} reports to ${this.parentOf(agentId)}, not ${by}.`);
  }

  private promptFor(rec: AgentRecord): string {
    return rec.role === "lead" ? leadPrompt(this.job, this.project, rec) : workerPrompt(this.job, this.project, rec);
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
      await this.refreshCacheNote().catch(() => undefined);
      const existing = await this.relay.getAgents(this.jobId);
      // Kaggle servers for the agents about to run come up first (in parallel). Workers' and leads' servers start
      // warming now too, so they're likely ready by the time the plan is approved.
      const first = existing.length ? existing.filter((r) => r.status !== "done").map((r) => r.model) : [this.roleModel(this.job.kind === "chat" ? "chat" : "orchestrator")];
      await Promise.all([...new Set(first)].map((m) => this.ensureModel(m)));
      if (this.job.kind === "team") {
        const later = [this.roleModel("worker"), ...(this.job.shape === "three-tier" ? [this.roleModel("lead")] : [])];
        for (const m of new Set(later)) void this.ensureModel(m).catch((e) => this.info(`Kaggle server for ${m} didn't start: ${(e as Error).message}`));
      }
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

  /** A chat without a project: an empty folder, no git (no branches, checkpoints, or merging). */
  private get scratch(): boolean {
    return this.project.name === NO_PROJECT;
  }

  private async prepareMain(): Promise<void> {
    if (this.scratch) {
      this.mainWt = join(env().WDASH_STATE_DIR, "scratch", this.jobId);
      mkdirSync(this.mainWt, { recursive: true });
      await this.syncAttachments(this.mainWt);
      return;
    }
    if (this.mode === "cloud") await G.fetchAll(this.repoDir);
    const base = await G.baseRef(this.repoDir, this.project.baseBranch, this.mode);
    this.mainWt = await G.addWorktree(this.repoDir, this.wtPath("main"), branchFor.main(this.jobId), base);
    for (const p of G.NEVER_COMMIT) await G.excludeFromGit(this.repoDir, p);
    await this.syncAttachments(this.mainWt);
    await G.pushBranches(this.repoDir, [branchFor.main(this.jobId)]).catch(async (e) => {
      await this.info(`Couldn't push job branch yet (${(e as Error).message.slice(0, 200)}). Cloud failover needs it pushed.`);
    });
  }

  private async startOrchestrator(): Promise<void> {
    await this.relay.setStatus(this.jobId, "planning");
    const rec: AgentRecord = {
      id: this.lead,
      role: "orchestrator",
      model: this.roleModel("orchestrator"),
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
    runner.start(`# Task from the user\n\n${this.job.task}${attached}\n\n${this.job.lite ? "Look only at what you need, then submit a plan with team_plan." : "Start by exploring the repo, then submit a plan with team_plan."}`);
  }

  private async startChat(): Promise<void> {
    await this.relay.setStatus(this.jobId, "running");
    const rec: AgentRecord = {
      id: CHAT_AGENT,
      role: "chat",
      model: this.roleModel("chat"),
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
    const runner = this.makeRunner(rec, this.mainWt, chatPrompt(this.job, this.project, this.scratch));
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
    if (this.scratch) return this.complete("Chat finished.");
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
      if (isTeamMember(rec.role) && rec.status === "done") {
        // Approved and merged earlier; nothing to resume.
        continue;
      }
      let cwd = this.mainWt;
      if (isTeamMember(rec.role)) {
        const parent = rec.parent ?? ORCH;
        const base = parent === ORCH ? branchFor.main(this.jobId) : branchFor.worker(this.jobId, parent);
        cwd = await G.addWorktree(this.repoDir, this.wtPath(rec.id), branchFor.worker(this.jobId, rec.id), base);
        await this.syncAttachments(cwd);
        this.workers.set(rec.id, { rounds: rec.reviewRounds, failedChecks: 0, approved: false, idleNudges: 0, startedAt: Date.now(), parent });
      }
      const prompt =
        rec.role === "orchestrator"
          ? orchestratorPrompt(this.job, this.project)
          : rec.role === "chat"
            ? chatPrompt(this.job, this.project, this.scratch)
            : this.promptFor(rec);
      const runner = this.makeRunner(rec, cwd, prompt);
      if (this.job.reopened) {
        // The job had finished; the user wrote again. Their message arrives next from the command stream.
        runner.start(
          rec.role === "chat"
            ? `[wdash] This chat had ended; the user reopened it with a follow-up (next message). Your earlier changes were already merged.`
            : `[wdash] This job had finished and its work is merged. The user reopened it with a follow-up (next message). ` +
                `Answer it; for more changes, spawn new workers (new names) as usual, then job_final_check and job_finish again.`,
        );
      } else {
        runner.start(
          `[wdash] This job was resumed on ${where} from the last checkpoint (${this.job.lastCheckpointSha ?? "start"}). ` +
            `Your working directory is now ${cwd}. Work after the checkpoint may be lost: check git status/diff, then continue.`,
        );
      }
    }
    if (this.job.reopened) {
      this.job.reopened = false;
      await this.relay.updateJob(this.jobId, { reopened: false, mergeState: "none" });
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

  /** The model an agent in `role` runs: a Claude model, "kaggle" (the server's default), or "kaggle:<model>". */
  private roleModel(role: AgentRecord["role"]): string {
    const j = this.job;
    if (role === "chat") return j.chatModel === "kaggle" && j.kaggleModel ? `kaggle:${j.kaggleModel}` : j.chatModel;
    const tier = role === "orchestrator" ? "orchestrator" : role === "lead" ? "lead" : "worker";
    const custom = j.models === "custom" ? { orchestrator: j.orchestratorModel, lead: j.leadModel, worker: j.workerModel }[tier] : "";
    if (custom) return custom;
    const m = MODEL_PRESETS[j.models][tier];
    if (m !== "kaggle") return m;
    const picked = (tier === "worker" && j.kaggleWorkerModel) || j.kaggleModel;
    return picked ? `kaggle:${picked}` : m;
  }

  /** Start (or reuse) the Kaggle server for a Kaggle model; Claude models need nothing. */
  private async ensureModel(model: string): Promise<void> {
    if (isKaggleModel(model)) await ensureKaggleFor(this.relay, kaggleModelName(model), (text) => this.info(text));
  }

  /** Index of worker-cache entries for this project (and "all"), appended to every agent's instructions. */
  private cacheNote = "";

  private async refreshCacheNote(): Promise<void> {
    const entries = Object.values(await this.relay.r.hgetall(K.workerCache))
      .map((v) => CacheEntry.safeParse(JSON.parse(v)))
      .filter((p) => p.success)
      .map((p) => p.data!)
      .filter((e) => e.scope === "all" || e.scope === this.project.name)
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!entries.length) {
      this.cacheNote = "\n\n# Worker cache\nEmpty so far. When you learn something reusable (build quirks, where things live, how to drive a tool), save it with cache_write.";
      return;
    }
    // A short index keeps every turn cheap; full entries come from cache_read.
    let index = "";
    for (const e of entries) {
      const line = `- ${e.id}: ${e.title}${e.body ? ` — ${e.body.replace(/\s+/g, " ").slice(0, 140)}` : ""}${e.links.length ? ` (${e.links.length} link${e.links.length === 1 ? "" : "s"})` : ""}\n`;
      if (index.length + line.length > 3500) break;
      index += line;
    }
    this.cacheNote = `\n\n# Worker cache\nShared notes from earlier work. Read the relevant ones with cache_read BEFORE exploring, to save time and tokens. Save new reusable findings with cache_write.\n${index}`;
  }

  private makeRunner(rec: AgentRecord, cwd: string, systemAppend: string): AgentRunner {
    const refs = this.job.refRepos ? this.job.refRepos.split(",").filter(Boolean) : [];
    const refNote = refs.length
      ? `\n\n# Reference repos\nThe user pointed this job at these GitHub repos for reference: ${refs.join(", ")}. Read them with open_repo when they help; don't push to them unless the task says so.`
      : "";
    const runner = new AgentRunner(this, rec, { cwd, systemAppend: systemAppend + refNote + this.cacheNote, env: this.agentEnv, lite: this.job.lite });
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
        // A long block costs one request per 30 s and still returns the moment a command arrives.
        cmds = await this.relay.readCommands(this.jobId, last, 30_000, this.cmdConn);
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
        if (cmd.agentId === "*") return this.conference(cmd.text);
        const woken = cmd.agentId && cmd.agentId !== this.lead ? await this.wakeWorker(cmd.agentId, "message from the user") : undefined;
        const target = woken ?? this.agents.get(cmd.agentId ?? this.lead) ?? this.agents.get(this.lead);
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
        if (!p || p.kind !== "permission") {
          // Stale (the PC restarted since it was asked): close the card and say so instead of doing nothing.
          const asked = await this.relay.getApproval(this.jobId, cmd.requestId);
          if (asked?.status === "pending") {
            await this.relay.putApproval({ ...asked, status: "expired", decidedAt: Date.now() });
            await clear(this.relay, this.jobId, "permission", cmd.requestId);
            await this.info(`That permission request had expired (the PC restarted). ${asked.agentId} will ask again if it still needs it.`);
          }
          return;
        }
        if (cmd.allow && cmd.scope === "job" && p.rule) await this.relay.addAllowRule(this.jobId, p.rule);
        p.resolve({ allow: cmd.allow, message: cmd.message, scope: cmd.scope });
        return;
      }
      case "answer": {
        const p = this.pending.get(cmd.requestId);
        if (p?.kind === "question") {
          p.resolve({ allow: true, answers: cmd.answers });
          return;
        }
        // The question is gone from this runner (the PC restarted, or it was answered in the chat first). Don't drop
        // the user's answer: deliver it as a message and close the card.
        const asked = await this.relay.getApproval(this.jobId, cmd.requestId);
        if (!asked || asked.status === "answered") return;
        await this.relay.putApproval({ ...asked, status: "answered", decidedAt: Date.now() });
        await clear(this.relay, this.jobId, "question", cmd.requestId);
        const text = Object.entries(cmd.answers)
          .map(([q, a]) => `- ${q}\n  → ${a}`)
          .join("\n");
        await this.handleCommand({ type: "user_message", agentId: asked.agentId, text: `Answers to your earlier question(s):\n${text}` });
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
          if (["failed", "stopped", "idle", "running"].includes(a.rec.status) && !(isTeamMember(a.rec.role) && this.workers.get(a.id)?.approved)) {
            if (a.rec.status === "failed") await this.ensureModel(a.rec.model).then(() => a.restart("[wdash] Resuming after an error. Check where you were and continue."));
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
        await this.ensureModel(a.rec.model);
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
        this.agents.get(this.parentOf(cmd.agentId))?.send(`[user] The user accepted ${cmd.agentId}'s work as-is. ${msg}`);
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

    if (isTeamMember(agent.rec.role)) {
      const ws = this.workers.get(agent.id);
      const waitingOnOwnWorkers = agent.rec.role === "lead" && [...this.workers.values()].some((w) => w.parent === agent.id && !w.approved);
      if (ws && !ws.approved && !ws.awaitingReview && !waitingOnOwnWorkers && agent.rec.status === "idle") {
        // A worker that stops without reporting done gets one automatic nudge, then the orchestrator decides.
        if (ws.idleNudges < 1) {
          ws.idleNudges++;
          agent.send("[wdash] You ended your turn without calling board_report_done. If you're finished, report done; if you're blocked, message the orchestrator with board_post.");
        } else {
          this.agents.get(ws.parent)?.send(`[wdash] ${agent.rec.role === "lead" ? "Lead" : "Worker"} ${agent.id} stopped without reporting done. Its last message: ${truncate(resultText(result), 1500)}`);
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
    if (agent.rec.role === "chat") return chatServer(this, agent.id);
    if (agent.rec.role === "lead") return leadServer(this, agent.id);
    return agent.rec.role === "orchestrator" ? orchestratorServer(this, agent.id) : workerServer(this, agent.id);
  }

  // =====================================================================
  // TeamApi (board tools)
  // =====================================================================

  async post(fromId: string, to: string, text: string): Promise<string> {
    const named = to === "all" ? undefined : ((await this.wakeWorker(to, `message from ${fromId}`)) ?? this.agents.get(to));
    const targets = to === "all" ? [...this.agents.values()].filter((a) => a.id !== fromId) : [named].filter((a): a is AgentRunner => !!a);
    if (!targets.length) throw new Error(`No agent named '${to}'. Agents: ${[...this.agents.keys()].join(", ")}`);
    await this.relay.r.xadd(K.board(this.jobId), "MAXLEN", "~", "5000", "*", "m", JSON.stringify({ ts: Date.now(), from: fromId, to, text }));
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "board", payload: { from: fromId, to, text } });
    for (const t of targets) {
      if (t.rec.status === "done" || t.rec.status === "stopped") continue;
      t.send(`[board] from ${fromId}: ${text}`);
    }
    return `Delivered to ${targets.map((t) => t.id).join(", ")}.`;
  }

  /**
   * Bring a finished worker back: a new runner on the same session (so it remembers), in its worktree
   * updated with the job branch. It goes through review again before the job can finish.
   * Returns undefined when `name` isn't a finished worker (live ones are returned as they are).
   */
  private async wakeWorker(name: string, why: string): Promise<AgentRunner | undefined> {
    const current = this.agents.get(name);
    if (current && !["done", "stopped", "failed"].includes(current.rec.status)) return current;
    if (this.scratch || this.finishing) return undefined;
    const rec = current?.rec ?? (await this.relay.getAgents(this.jobId)).find((r) => r.id === name);
    if (!rec || !isTeamMember(rec.role)) return undefined;
    const parent = rec.parent ?? ORCH;
    const base = parent === ORCH ? branchFor.main(this.jobId) : branchFor.worker(this.jobId, parent);
    const branch = rec.branch ?? branchFor.worker(this.jobId, name);
    const cwd = await G.addWorktree(this.repoDir, this.wtPath(name), branch, base);
    await G.mergeInto(cwd, base, "wdash: sync with parent branch").catch(() => undefined);
    await this.syncAttachments(cwd);
    const prev = this.workers.get(name);
    this.workers.set(name, { rounds: rec.reviewRounds, failedChecks: 0, approved: false, idleNudges: 0, startedAt: Date.now(), helps: prev?.helps, helpAsked: true, parent });
    await this.relay.setClaims(this.jobId, name, rec.globs);
    rec.status = "starting";
    await this.ensureModel(rec.model);
    const runner = this.makeRunner(rec, cwd, this.promptFor(rec));
    await runner.save();
    runner.start(
      `[wdash] You finished earlier and your work was merged; you've been woken up (${why}). Your worktree has the latest work from ${parent === ORCH ? "the job branch" : `your lead ${parent}`}. ` +
        `Do what's asked; if you change files, call board_report_done again when finished.`,
    );
    await this.info(`Woke ${name} (${why}).`);
    return runner;
  }

  /** Conference call: the user's message goes to the whole team, finished workers included. */
  private async conference(text: string): Promise<void> {
    await this.relay.emit({ jobId: this.jobId, agentId: "everyone", type: "message", payload: { role: "user", text, conference: true } });
    await clear(this.relay, this.jobId, "waiting_for_input");
    const names = new Set([...this.agents.keys(), ...(await this.relay.getAgents(this.jobId)).map((r) => r.id)]);
    for (const name of names) {
      const a = name === this.lead ? this.agents.get(name) : ((await this.wakeWorker(name, "conference call")) ?? this.agents.get(name));
      if (!a || ["done", "stopped", "failed"].includes(a.rec.status)) continue;
      a.send(
        `[conference] The user, on a call with the whole team (${[...names].join(", ")}): ${text}\n\n` +
          `Answer the user directly in 1-3 short, spoken-style sentences (it may be read aloud): what you're doing, or your answer. Then carry on.`,
      );
      if (a.rec.status === "idle") await a.setStatus("running");
    }
  }

  /**
   * UI/visual design work starts only after the user has been grilled: the orchestrator (or a lead) must have had at
   * least one AskUserQuestion answered in this job. Checked from the stored approvals, so it survives restarts.
   */
  private async requireGrillForUi(workers: PlannedWorker[]): Promise<void> {
    if (!workers.some((w) => w.ui)) return;
    const approvals = Object.values(await this.relay.r.hgetall(K.approvals(this.jobId))).map((v) => JSON.parse(v) as Approval);
    const grilled = approvals.some((a) => a.kind === "question" && a.status === "answered" && (a.agentId === ORCH || this.agents.get(a.agentId)?.rec.role === "lead"));
    if (!grilled)
      throw new Error(
        "This plan has UI/design work (ui: true). Grill the user first: ask about goal and audience, look and feel (references), must-haves, colors/fonts and devices with AskUserQuestion, then submit the plan again.",
      );
  }

  async submitPlan(summary: string, workers: PlannedWorker[]): Promise<string> {
    const fixed = this.job.workers === "auto" ? undefined : Number(this.job.workers);
    if (fixed && workers.length !== fixed) throw new Error(`The user asked for exactly ${fixed} worker(s); your plan has ${workers.length}.`);
    if (this.job.shape === "three-tier" && workers.some((w) => !w.lead))
      throw new Error("This job is set to a 3-tier team: mark every plan item lead: true (each lead splits its area among its own workers).");
    const names = new Set<string>();
    for (const w of workers) {
      if (names.has(w.name) || w.name === ORCH || w.name === "main" || this.agents.has(w.name)) throw new Error(`Duplicate or reserved worker name: ${w.name}`);
      names.add(w.name);
    }
    await this.requireGrillForUi(workers);
    for (let i = 0; i < workers.length; i++)
      for (let j = i + 1; j < workers.length; j++)
        for (const a of workers[i]!.globs)
          for (const b of workers[j]!.globs)
            if (globsOverlap(a, b)) throw new Error(`Ownership overlaps: ${workers[i]!.name}:${a} vs ${workers[j]!.name}:${b}. Make the globs disjoint.`);

    await this.relay.emit({ jobId: this.jobId, agentId: this.lead, type: "plan", payload: { summary, workers } });
    if (workers.length >= 3) {
      this.pendingPlan = { summary, workers };
      await this.relay.setStatus(this.jobId, "awaiting_plan_approval");
      const model = (w: PlannedWorker) => (w.ui ? " [UI, opus]" : w.model ? ` [${w.model}]` : "");
      const detail = `${summary}\n\n${workers.map((w) => `• ${w.name}${w.lead ? " (lead)" : ""}${model(w)} — ${w.globs.join(", ")}`).join("\n")}`;
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

  async spawnWorker(w: PlannedWorker, by: string = ORCH): Promise<string> {
    if (this.agents.has(w.name) || w.name === ORCH || w.name === "main") throw new Error(`Name ${w.name} is taken.`);
    if (this.workers.size >= MAX_WORKERS) throw new Error(`This job already has ${MAX_WORKERS} workers (the cap).`);
    const byLead = by !== ORCH;
    if (byLead) {
      const lead = this.agents.get(by);
      if (!lead || lead.rec.role !== "lead") throw new Error("Only the orchestrator and leads can spawn workers.");
      if (w.lead) throw new Error("A lead's workers can't be leads themselves (3 tiers at most).");
      const outside = w.globs.filter((g) => !lead.rec.globs.some((lg) => globsOverlap(g, lg)));
      if (outside.length) throw new Error(`Outside your area (${lead.rec.globs.join(", ")}): ${outside.join(", ")}. Ask the orchestrator with board_request_files.`);
    }
    const claims = await this.relay.getClaims(this.jobId);
    if (w.helps) {
      const helped = this.workers.get(w.helps);
      if (!helped || !this.agents.has(w.helps)) throw new Error(`No worker ${w.helps} to help.`);
      if (helped.helps) throw new Error(`${w.helps} is itself a helper; split the original worker's work instead.`);
      if (helped.parent !== by) throw new Error(`${w.helps} reports to ${helped.parent}; only it can add helpers for ${w.helps}.`);
      const helpers = [...this.workers.values()].filter((x) => x.helps === w.helps).length;
      if (helpers >= MAX_HELPERS) throw new Error(`${w.helps} already has ${MAX_HELPERS} helpers.`);
    }
    // A helper may take paths from the worker it helps, and a lead's worker from its lead's area; no one else's.
    const lender = w.helps ?? (byLead ? by : undefined);
    const others = lender ? Object.fromEntries(Object.entries(claims).filter(([, owner]) => owner !== lender)) : claims;
    const conflicts = conflictingClaims(others, w.globs, w.name);
    if (conflicts.length) throw new Error(`Ownership conflicts: ${conflicts.join("; ")}`);
    const branch = branchFor.worker(this.jobId, w.name);
    const base = byLead ? this.agents.get(by)!.rec.branch ?? branchFor.worker(this.jobId, by) : branchFor.main(this.jobId);
    if (byLead) await G.checkpointCommit(this.agents.get(by)!.cwd, `wdash: ${by} before spawning ${w.name}`).catch(() => undefined);
    const cwd = await G.addWorktree(this.repoDir, this.wtPath(w.name), branch, base);
    await this.syncAttachments(cwd);
    const role = w.lead ? "lead" : "worker";
    // UI/design work always runs on Opus; otherwise the planner's pick, else the job's model for the tier.
    if (w.ui) await this.requireGrillForUi([w]);
    const model = w.ui ? "opus" : w.model || this.roleModel(role);
    await this.ensureModel(model);
    await this.refreshCacheNote();
    const rec: AgentRecord = {
      id: w.name,
      role,
      model,
      name: w.name,
      task: w.task,
      globs: w.globs,
      status: "starting",
      branch,
      parent: by,
      reviewRounds: 0,
      lastEventAt: Date.now(),
      costUsd: 0,
    };
    await this.relay.setClaims(this.jobId, w.name, w.globs);
    this.workers.set(w.name, { rounds: 0, failedChecks: 0, approved: false, idleNudges: 0, startedAt: Date.now(), helps: w.helps, parent: by });
    const runner = this.makeRunner(rec, cwd, this.promptFor(rec));
    await runner.save();
    runner.start(
      role === "lead"
        ? `# Your area\n\n${w.task}\n\nYou own: ${w.globs.join(", ")}. Split it among your own workers with team_spawn_worker, review and merge them, then call board_report_done.`
        : `# Your task\n\n${w.task}\n\nYou own: ${w.globs.join(", ")}. When finished, call board_report_done.`,
    );
    if (byLead) await this.info(`Lead ${by} started worker ${w.name} on ${w.globs.join(", ")}.`);
    if (w.helps) {
      this.agents
        .get(w.helps)
        ?.send(`[wdash] Helper ${w.name} is taking over ${w.globs.join(", ")} to speed things up. Don't edit those paths any more; call sync_with_main later to get its merged work.`);
      await this.info(`Helper ${w.name} is helping ${w.helps} with ${w.globs.join(", ")}.`);
    }
    return `Spawned ${w.name}.`;
  }

  async grantFiles(agentId: string, globs: string[], by: string = ORCH): Promise<string> {
    const a = this.agents.get(agentId);
    if (!a || !isTeamMember(a.rec.role)) throw new Error(`No worker ${agentId}`);
    this.assertParent(agentId, by);
    let claims = await this.relay.getClaims(this.jobId);
    if (by !== ORCH) {
      const lead = this.agents.get(by)!;
      const outside = globs.filter((g) => !lead.rec.globs.some((lg) => globsOverlap(g, lg)));
      if (outside.length) throw new Error(`Outside your area: ${outside.join(", ")}. Ask the orchestrator with board_request_files.`);
      claims = Object.fromEntries(Object.entries(claims).filter(([, owner]) => owner !== by));
    }
    const conflicts = conflictingClaims(claims, globs, agentId);
    if (conflicts.length) throw new Error(`Can't grant, already owned: ${conflicts.join("; ")}`);
    await this.relay.setClaims(this.jobId, agentId, globs);
    a.rec.globs = [...new Set([...a.rec.globs, ...globs])];
    await a.save();
    a.send(`[board] from ${by}: You now also own ${globs.join(", ")}.`);
    return `Granted ${globs.join(", ")} to ${agentId}.`;
  }

  async denyFiles(agentId: string, reason: string, by: string = ORCH): Promise<string> {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`No agent ${agentId}`);
    a.send(`[board] from ${by}: File request denied: ${reason}`);
    return "Denied.";
  }

  async requestFiles(fromId: string, globs: string[], reason: string): Promise<string> {
    const claims = await this.relay.getClaims(this.jobId);
    const conflicts = conflictingClaims(claims, globs, fromId);
    const note = conflicts.length ? ` Note: overlaps existing claims: ${conflicts.join("; ")}.` : "";
    const to = this.parentOf(fromId);
    this.agents.get(to)?.send(`[board] from ${fromId}: requests files ${globs.join(", ")} — ${reason}.${note} Use board_grant_files or board_deny_files.`);
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "board", payload: { from: fromId, to, text: `Requests files ${globs.join(", ")}: ${reason}` } });
    return `Request sent to ${to}. Work on something else or end your turn until you hear back.`;
  }

  async reportDone(fromId: string, summary: string): Promise<string> {
    const a = this.agents.get(fromId);
    const ws = this.workers.get(fromId);
    if (!a || !ws) throw new Error("Only workers and leads can report done.");
    if (a.rec.role === "lead") {
      const open = [...this.workers.entries()].filter(([, s]) => s.parent === fromId && !s.approved).map(([n]) => n);
      if (open.length) throw new Error(`Your workers aren't all merged yet: ${open.join(", ")}. Review and approve them first.`);
    }
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
    this.agents.get(ws.parent)?.send(
      `[board] ${a.rec.role === "lead" ? "Lead " : ""}${fromId} reports done: ${summary}\nChecks at ${sha.slice(0, 8)}: ${checksSummary(results)}\nReview with review_diff, then board_approve or board_request_changes.`,
    );
    return passed
      ? `Reported. Checks passed. ${ws.parent === ORCH ? "The orchestrator" : `Your lead ${ws.parent}`} will review; end your turn now.`
      : `Reported, but checks FAILED: ${checksSummary(results)}. Fix them now unless the orchestrator tells you otherwise.`;
  }

  async reviewDiff(agentId: string, by: string = ORCH): Promise<string> {
    const a = this.agents.get(agentId);
    if (!a || !isTeamMember(a.rec.role)) throw new Error(`No worker ${agentId}`);
    this.assertParent(agentId, by);
    const d = await G.diffAgainst(a.cwd, this.parentBranch(agentId));
    await this.relay.emit({ jobId: this.jobId, agentId, type: "diff", payload: { branch: a.rec.branch, files: d.files, stat: d.stat, patch: d.patch } });
    const ws = this.workers.get(agentId);
    const checks = ws?.lastChecks ? `Checks at ${ws.lastChecks.sha.slice(0, 8)}: ${checksSummary(ws.lastChecks.results)}` : "No checks run yet.";
    return `${checks}\nReview round ${ws?.rounds ?? 0}/${this.job.reviewCap}\n\n${d.stat}\n\n${truncate(d.patch, this.job.lite ? 20_000 : 60_000)}`;
  }

  async requestChanges(agentId: string, notes: string, by: string = ORCH): Promise<string> {
    const a = this.agents.get(agentId);
    const ws = this.workers.get(agentId);
    if (!a || !ws) throw new Error(`No worker ${agentId}`);
    this.assertParent(agentId, by);
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
    a.send(`[review round ${ws.rounds}/${this.job.reviewCap}] ${by === ORCH ? "The orchestrator" : `Your lead ${by}`} requests changes:\n${notes}\n\n${a.rec.role === "lead" ? "Get them fixed by your workers, merge, and call board_report_done again." : "Fix them and call board_report_done again."}`);
    return `Sent back to ${agentId} (round ${ws.rounds}/${this.job.reviewCap}).`;
  }

  async approve(agentId: string, by: string = ORCH): Promise<string> {
    const a = this.agents.get(agentId);
    const ws = this.workers.get(agentId);
    if (!a || !ws) throw new Error(`No worker ${agentId}`);
    this.assertParent(agentId, by);
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
    const target = this.parentWorktree(agentId);
    const res = await G.mergeInto(target, a.rec.branch!, `wdash: merge ${agentId}${forced ? " (accepted by user)" : ""}`);
    if (!res.ok) {
      return `Merge conflict merging ${agentId}: ${res.conflicts.join(", ")}. Ask ${agentId} to call sync_with_main and resolve, then report done again.`;
    }
    ws.approved = true;
    await a.stop("done");
    await this.checkpoint("merge");
    if (ws.parent !== ORCH) {
      // Merged into a lead's branch: the lead reports its whole area once all its workers are in.
      const mine = [...this.workers.entries()].filter(([, s]) => s.parent === ws.parent && !s.approved).map(([n]) => n);
      return `Merged ${agentId} into your branch. ${mine.length ? `Still open: ${mine.join(", ")}.` : "All your workers are merged: call board_report_done with a summary of your area."}`;
    }
    this.finalChecks = undefined;
    const left = [...this.workers.entries()].filter(([, s]) => !s.approved && s.parent === ORCH).map(([n]) => n);
    return `Merged ${agentId} into the job branch. ${left.length ? `Still open: ${left.join(", ")}.` : "All workers merged: run job_final_check, review the combined result, then job_finish."}`;
  }

  async syncWithMain(fromId: string): Promise<string> {
    const a = this.agents.get(fromId);
    if (!a) throw new Error("unknown agent");
    await G.checkpointCommit(a.cwd, `wdash: ${fromId} before sync`);
    const parent = this.parentOf(fromId);
    if (parent !== ORCH) {
      const lead = this.agents.get(parent);
      if (lead) await G.checkpointCommit(lead.cwd, `wdash: ${parent} before ${fromId} syncs`).catch(() => undefined);
    }
    const res = await G.mergeInto(a.cwd, this.parentBranch(fromId), `wdash: sync with ${parent === ORCH ? "job branch" : `${parent}'s branch`}`);
    if (res.ok) return parent === ORCH ? "Merged the job branch into yours." : `Merged your lead ${parent}'s branch into yours.`;
    return `Conflicts in ${res.conflicts.join(", ")}; the merge was aborted. Ask ${parent} for help or for ownership of those files.`;
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
    return `Final checks at ${sha.slice(0, 8)}: ${checksSummary(results)}\n\nCombined diff:\n${d.stat}\n\n${truncate(d.patch, this.job.lite ? 20_000 : 60_000)}`;
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
    if (this.scratch) {
      mergeState = "none";
    } else if (this.mode === "home" && this.project.localPath) {
      const out = await G.syncIntoCheckout(this.project.localPath, this.project.baseBranch, this.jobId);
      if (out.kind === "merged") {
        mergeState = "merged";
        detail = `${summary}\n\nMerged into ${this.project.baseBranch} on your PC.`;
        if (this.project.pushOnMerge) {
          const err = await G.pushBase(this.project.localPath, this.project.baseBranch);
          detail += err ? ` Couldn't push it to GitHub: ${err}` : " Pushed to GitHub.";
          await this.info(err ? `Couldn't push ${this.project.baseBranch} to GitHub: ${err}` : `Pushed ${this.project.baseBranch} to GitHub (${this.project.repo}).`);
        }
      } else if (out.kind === "needs_merge") {
        // The PC checkout can't take it; merge on GitHub instead so nobody has to open a PR.
        const gh = this.project.pushOnMerge ? await this.mergeOnGitHub() : out;
        if (gh.kind === "merged") {
          mergeState = "merged";
          detail = `${summary}\n\nMerged into ${this.project.baseBranch} on GitHub. Your PC checkout was left alone: ${out.why}`;
        } else if (gh.kind === "needs_merge") {
          mergeState = "needs_merge";
          await this.notify("needs_merge", { detail: `${gh.why}${gh.conflicts?.length ? ` Conflicts: ${gh.conflicts.join(", ")}` : ""}` });
        }
      }
    } else {
      const gh = this.project.pushOnMerge ? await this.mergeOnGitHub() : undefined;
      if (gh?.kind === "merged") {
        mergeState = "merged";
        detail = `${summary}\n\nMerged into ${this.project.baseBranch} on GitHub.`;
      } else if (gh?.kind === "needs_merge") {
        mergeState = "needs_merge";
        await this.notify("needs_merge", { detail: `${gh.why}${gh.conflicts?.length ? ` Conflicts: ${gh.conflicts.join(", ")}` : ""}` });
      } else {
        detail = `${summary}\n\nIt will merge into your PC's checkout when the PC is back online.`;
      }
      // Either way the PC checkout catches up (or merges) when the PC is next online.
      await this.relay.r.zadd(K.mergeQueue, Date.now(), this.jobId);
    }
    const deployed = await this.autoDeploy();
    if (deployed) detail += `\n\n${deployed}`;
    await this.relay.updateJob(this.jobId, { mergeState });
    await this.relay.setStatus(this.jobId, "done", { summary });
    await clearJob(this.relay, this.jobId, ["needs_merge"]);
    await this.notify("job_finished", { detail: truncate(detail, 600) });
    await this.end("done", false);
  }

  private async mergeOnGitHub(): Promise<G.SyncOutcome> {
    const out = await G.mergeOnGitHub(this.mainWt, this.project.baseBranch);
    await this.info(
      out.kind === "merged"
        ? `Merged into ${this.project.baseBranch} on GitHub (${this.project.repo}, ${out.sha.slice(0, 8)}).`
        : `Couldn't merge on GitHub: ${out.kind === "needs_merge" ? out.why : "job branch missing"} The work is on branch ${branchFor.main(this.jobId)}.`,
    );
    return out;
  }

  /** Auto-deploy projects: deploy the finished job branch to production. Never fails the job. */
  private async autoDeploy(): Promise<string | undefined> {
    if (!this.project.autoDeploy || this.scratch) return undefined;
    if (!vercelConfigured()) {
      await this.info("Auto-deploy is on for this project, but this runner has no Vercel token (VERCEL_TOKEN / WDASH_VERCEL_TOKEN). Skipped the deploy.");
      return "Not deployed: no Vercel token on this runner.";
    }
    const name = vercelProjectName(this.project.name);
    await this.info(`Deploying ${name} to Vercel…`);
    try {
      const url = await vercelDeploy(this.mainWt, name, true);
      await this.info(`Deployed ${name} to Vercel: ${url}`);
      return `Live on Vercel: ${url}`;
    } catch (e) {
      const msg = (e as Error).message;
      await this.info(`Auto-deploy failed: ${msg}`);
      return `Vercel deploy failed: ${truncate(msg, 300)}`;
    }
  }

  // =====================================================================
  // budget, usage, stalls, checkpoints
  // =====================================================================

  private async recordUsage(agent: AgentRunner, r: SDKResultMessage): Promise<void> {
    // The SDK's totals are per run of an agent and restart at zero when it resumes (after a PC restart or a
    // move to the cloud), so add them to what earlier runs recorded.
    let base = this.usageBase.get(agent.id);
    if (!base) {
      const prev = await this.relay.r.hget(K.usage(this.jobId), agent.id);
      base = prev ? (JSON.parse(prev) as UsageTotals) : { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0 };
      this.usageBase.set(agent.id, base);
    }
    const u = r.usage as unknown as Record<string, number>;
    // Output tokens per second: this turn's (since the previous result of the same run) and the agent's average.
    const runOut = u.output_tokens ?? 0;
    const runMs = r.duration_api_ms ?? 0;
    const prev = this.lastRun.get(agent.id);
    const fresh = !prev || runOut < prev.out || runMs < prev.apiMs; // a new run (restart/resume) starts from zero
    const dOut = runOut - (fresh ? 0 : prev.out);
    const dMs = runMs - (fresh ? 0 : prev.apiMs);
    this.lastRun.set(agent.id, { out: runOut, apiMs: runMs });
    const outputTokens = base.outputTokens + runOut;
    const apiMs = (base.apiMs ?? 0) + runMs;
    await this.relay.r.hset(
      K.usage(this.jobId),
      agent.id,
      JSON.stringify({
        costUsd: agent.rec.costUsd,
        inputTokens: base.inputTokens + (u.input_tokens ?? 0),
        outputTokens,
        cacheReadTokens: base.cacheReadTokens + (u.cache_read_input_tokens ?? 0),
        cacheWriteTokens: base.cacheWriteTokens + (u.cache_creation_input_tokens ?? 0),
        turns: base.turns + (r.num_turns ?? 0),
        apiMs,
        tps: apiMs > 0 ? Math.round((outputTokens / apiMs) * 10_000) / 10 : undefined,
        lastTps: dMs > 500 && dOut > 0 ? Math.round((dOut / dMs) * 10_000) / 10 : undefined,
        model: agent.rec.model,
      }),
    );
    // Every agent the job ever had, not just the ones running now (merged workers aren't resumed).
    const live = new Map([...this.agents.values()].map((a) => [a.id, a.rec.costUsd || 0]));
    for (const rec of await this.relay.getAgents(this.jobId)) if (!live.has(rec.id)) live.set(rec.id, rec.costUsd || 0);
    const total = [...live.values()].reduce((s, c) => s + c, 0);
    this.job.costUsd = total;
    let tokensIn = 0;
    let tokensOut = 0;
    for (const v of Object.values(await this.relay.r.hgetall(K.usage(this.jobId)))) {
      const x = JSON.parse(v) as Record<string, number>;
      tokensIn += (x.inputTokens ?? 0) + (x.cacheReadTokens ?? 0) + (x.cacheWriteTokens ?? 0);
      tokensOut += x.outputTokens ?? 0;
    }
    await this.relay.updateJob(this.jobId, { costUsd: total.toFixed(4), tokensIn, tokensOut });
    await this.relay.emit({ jobId: this.jobId, agentId: agent.id, type: "usage", payload: { agent: agent.id, costUsd: agent.rec.costUsd, jobCostUsd: total } });
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
    await this.offerHelpers();
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

  /**
   * A worker that's been at it for a while gets help: the orchestrator is asked (once per worker) to split
   * its remaining work across up to MAX_HELPERS new workers. Helpers don't get helpers.
   */
  private async offerHelpers(): Promise<void> {
    if (this.job.kind === "chat" || this.finishing) return;
    const after = env().WDASH_HELP_MINUTES * 60_000;
    for (const [name, ws] of this.workers) {
      const a = this.agents.get(name);
      if (!a || ws.helps || ws.helpAsked || ws.approved || ws.awaitingReview || !ws.startedAt) continue;
      if (!["running", "starting", "idle"].includes(a.rec.status) || Date.now() - ws.startedAt < after) continue;
      ws.helpAsked = true;
      const mins = Math.round((Date.now() - ws.startedAt) / 60_000);
      await this.info(`${name} has been working for ${mins} min; asking ${ws.parent} to split its work across helpers.`);
      if (a.rec.role === "lead") continue; // a lead's own workers get helpers, not the lead
      this.agents.get(ws.parent)?.send(
        `[wdash] Worker ${name} has been working for ${mins} minutes on: ${truncate(a.rec.task, 400)}\n` +
          `It owns: ${a.rec.globs.join(", ")}. Speed it up: ask it (board_post) what's left, then spawn up to ${MAX_HELPERS} helper workers with team_spawn_worker, ` +
          `each with helps: "${name}", a clear slice of the remaining work, and a subset of ${name}'s paths (no two helpers on the same paths). ` +
          `Those paths move to the helper. Skip it if ${name} is nearly done.`,
      );
    }
  }

  /** Commit WIP everywhere and push all job branches so another machine can take over (SPEC.md §10). */
  private async checkpoint(why: string): Promise<void> {
    this.lastCheckpointAt = Date.now();
    if (this.scratch) return; // nothing to save in git
    const branches = [branchFor.main(this.jobId)];
    for (const a of this.agents.values()) {
      // A chat agent edits the job branch itself, so its work is checkpointed there.
      if (a.rec.role === "chat") await G.checkpointCommit(a.cwd, `wdash: checkpoint (${why})`).catch(() => undefined);
      if (!isTeamMember(a.rec.role)) continue;
      branches.push(a.rec.branch!);
      await G.checkpointCommit(a.cwd, `wdash: checkpoint (${why})`).catch(() => undefined);
    }
    const sha = await G.head(this.mainWt);
    try {
      await G.pushBranches(this.repoDir, branches);
    } catch {
      // Retry one by one so the good branches still get saved, and report why the others failed.
      const failed = await G.pushEach(this.repoDir, branches);
      if (failed.length) {
        await this.info(`Checkpoint push failed for ${failed.map((f) => `${f.branch.split("/").pop()}: ${f.why}`).join("; ")}`.slice(0, 1500));
        return;
      }
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
        data = await this.relay.getAttachmentData(this.jobId, f);
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

  async openRepo(fromId: string, repo: string): Promise<string> {
    const a = this.agents.get(fromId);
    if (!a) throw new Error("unknown agent");
    const dir = await openRepo(a.cwd, repo);
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "info", payload: { text: `${fromId} opened ${repo}` } });
    return `${repo} is at ${dir}. Edit files there, then call push_repo to push your changes to its default branch.`;
  }

  async pushRepo(fromId: string, repo: string, message: string): Promise<string> {
    const a = this.agents.get(fromId);
    if (!a) throw new Error("unknown agent");
    const out = await pushRepo(a.cwd, repo, message);
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "info", payload: { text: out } });
    return out;
  }

  async cacheRead(id: string): Promise<string> {
    const raw = await this.relay.r.hget(K.workerCache, id);
    if (!raw) throw new Error(`No worker-cache entry "${id}".`);
    const e = CacheEntry.parse(JSON.parse(raw));
    return `# ${e.title}\n(scope ${e.scope}, by ${e.by}, updated ${new Date(e.updatedAt).toLocaleString()})\n\n${e.body}${e.links.length ? `\n\nLinks (read with WebFetch):\n${e.links.map((l) => `- ${l}`).join("\n")}` : ""}`;
  }

  async cacheWrite(fromId: string, entry: { id: string; title: string; body: string; scope?: string; links?: string[] }): Promise<string> {
    const e = CacheEntry.parse({ ...entry, scope: entry.scope || "all", links: entry.links ?? [], updatedAt: Date.now(), by: `${this.jobId}/${fromId}` });
    await this.relay.r.hset(K.workerCache, e.id, JSON.stringify(e));
    await this.info(`${fromId} saved "${e.title}" to the worker cache.`);
    return `Saved worker-cache entry ${e.id}.`;
  }

  /** Facts for a usage estimate (usage_quote tool): this job so far, past jobs, Claude limits, Kaggle hours. */
  async usageQuote(): Promise<string> {
    const j = (await this.relay.getJob(this.jobId)) ?? this.job;
    const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
    const tiers = j.kind === "chat" ? this.roleModel("chat") : `${this.roleModel("orchestrator")} orchestrator, ${this.roleModel("lead")} leads, ${this.roleModel("worker")} workers`;
    const agentsNow = this.agents.size;
    const out: string[] = [
      "# This job",
      `Models: ${tiers} (preset ${j.models}). Workers: ${j.workers}. Shape: ${j.shape}. Low usage mode: ${j.lite ? "on" : "off"}.`,
      `Used so far: $${j.costUsd.toFixed(2)} of a $${j.budgetUsd} budget (API-equivalent), ${k(j.tokensIn)} tokens in / ${k(j.tokensOut)} out, ${agentsNow} agent(s), ${Math.round((Date.now() - j.createdAt) / 60_000)} min.`,
    ];

    // Finished jobs with a cost, newest first; "similar" = same kind and model preset.
    const past: Array<{ job: JobRecord; agents: number }> = [];
    for (const id of await this.relay.r.zrevrange(K.jobs, 0, 80)) {
      if (id === this.jobId || past.length >= 30) continue;
      const pj = await this.relay.getJob(id).catch(() => undefined);
      if (!pj || !TERMINAL_STATUSES.includes(pj.status) || !(pj.costUsd > 0)) continue;
      past.push({ job: pj, agents: (await this.relay.getAgents(id).catch(() => [])).length });
    }
    const similar = past.filter((p) => p.job.kind === j.kind && p.job.models === j.models);
    const pool = similar.length >= 3 ? similar : past.filter((p) => p.job.kind === j.kind);
    const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]! : 0);
    const mins = (p: { job: JobRecord }) => Math.max(1, Math.round((p.job.updatedAt - p.job.createdAt) / 60_000));
    out.push("", `# Past ${j.kind} jobs (${similar.length >= 3 ? `same preset ${j.models}` : "all presets"}, newest first)`);
    if (!pool.length) out.push("No finished jobs with costs yet: estimate from the plan size (roughly $0.05-0.30 per Haiku/Sonnet agent for small tasks, several times that for Opus).");
    for (const p of pool.slice(0, 10)) {
      out.push(`- "${p.job.title.slice(0, 60)}": ${p.job.models}, ${p.agents} agent(s), $${p.job.costUsd.toFixed(2)}, ${k(p.job.tokensIn)} in / ${k(p.job.tokensOut)} out, ~${mins(p)} min, ${p.job.status}`);
    }
    if (pool.length) {
      const perAgent = pool.filter((p) => p.agents > 0).map((p) => p.job.costUsd / p.agents);
      out.push(
        `Medians over ${pool.length}: $${median(pool.map((p) => p.job.costUsd)).toFixed(2)} per job, $${median(perAgent).toFixed(2)} per agent, ${k(median(pool.map((p) => p.job.tokensIn + p.job.tokensOut)))} tokens, ~${median(pool.map(mins))} min.`,
      );
    }

    out.push("", "# Claude subscription limits (latest reported)");
    const limits = Object.entries(await this.relay.r.hgetall(K.rateLimit))
      .map(([type, raw]) => ({ type, ...(JSON.parse(raw) as { utilization?: number; resetsAt?: number; status?: string }) }))
      .filter((l) => !l.resetsAt || l.resetsAt * 1000 > Date.now());
    if (!limits.length) out.push("None reported yet (no recent Claude turns).");
    for (const l of limits) {
      const pct = typeof l.utilization === "number" ? `${Math.round((l.utilization > 1.5 ? l.utilization / 100 : l.utilization) * 100)}% used` : (l.status ?? "?");
      out.push(`- ${l.type}: ${pct}${l.resetsAt ? `, resets ${new Date(l.resetsAt * 1000).toLocaleString()}` : ""}`);
    }

    const sessions = (await this.relay.r.zrangebyscore(K.kaggleSessions, Date.now() - 7 * 86_400_000, "+inf")).map((s) => JSON.parse(s) as KaggleSession);
    const running = Object.values(await this.relay.r.hgetall(K.kaggleServers)).map((s) => JSON.parse(s) as { user?: string; accel?: KaggleAccel; startedAt: number });
    const hours = kaggleHours(sessions, running, Date.now());
    out.push("", "# Kaggle (free open models)");
    out.push(hours.length ? hours.map((h) => `- ${h.user} ${h.accel.toUpperCase()}: ${h.hours} of ${h.quota} h used in the last 7 days`).join("\n") : "No Kaggle hours used in the last 7 days.");
    out.push(`${running.length} server(s) running. Kaggle agents cost $0 and no Claude limits, but are slower (roughly 30-60 s per turn) and use Kaggle hours; a cold server takes 5-15 min to boot.`);

    out.push(
      "",
      "Dollar figures are API-equivalent: on a Claude subscription the real cost is the share of the limits above. Quote a range (cost, tokens, time, and what share of the 5-hour/weekly limit it may take, judged from past jobs and current use), say what drives it (number of agents, model, review rounds), and say it's an estimate.",
    );
    return out.join("\n");
  }

  async vercelDeploy(fromId: string, path: string, project: string | undefined, production: boolean): Promise<string> {
    const a = this.agents.get(fromId);
    if (!a) throw new Error("unknown agent");
    const dir = resolve(a.cwd, path);
    if (!inside(a.cwd, dir)) throw new Error(`${path} is outside your working directory.`);
    // A repo opened with open_repo deploys under its own name, not the job's project.
    const opened = relative(join(a.cwd, OTHER_REPOS_DIR), dir).split(/[\\/]/)[0];
    const fallback = opened && !opened.startsWith("..") ? opened.split("__").pop()! : this.scratch ? this.job.title : this.project.name;
    const name = vercelProjectName(project || fallback);
    const target = production ? "production" : "preview";
    const rule = `vercel_deploy:${name}:${target}`;
    // Auto-deploy projects deploy on their own; other repos and other names still ask.
    const own = this.project.autoDeploy && !this.scratch && name === vercelProjectName(this.project.name);
    if (!own && !(await this.relay.getAllowRules(this.jobId)).includes(rule)) {
      const ok = await this.requestPermission(
        a,
        "vercel_deploy",
        { path, project: name, production },
        `Deploy ${path === "." ? "this repo" : path} to Vercel (${name}, ${target})`,
        rule,
        new AbortController().signal,
      );
      if (!ok.allow) throw new Error(ok.message ? `User denied the deploy: ${ok.message}` : "User denied the deploy.");
    }
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "info", payload: { text: `${fromId} is deploying ${name} to Vercel (${target})…` } });
    const url = await vercelDeploy(dir, name, production);
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "info", payload: { text: `Deployed ${name} to Vercel: ${url}` } });
    return `Deployed ${name} (${target}): ${url}`;
  }

  async shareFile(fromId: string, path: string, note?: string): Promise<string> {
    const a = this.agents.get(fromId);
    if (!a) throw new Error("unknown agent");
    const abs = resolve(a.cwd, path);
    if (!inside(a.cwd, abs)) throw new Error(`${path} is outside your working directory.`);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`${path} isn't a file.`);
    const size = statSync(abs).size;
    if (size > MAX_SHARE_BYTES) throw new Error(`${path} is ${(size / 1024 / 1024).toFixed(1)} MB; files you share can be at most ${MAX_SHARE_BYTES / 1024 / 1024} MB.`);
    const existing = await this.relay.listFiles(this.jobId);
    if (existing.length >= MAX_ATTACHMENTS) throw new Error(`This job already has ${MAX_ATTACHMENTS} files.`);
    const name = uniqueFileName(safeFileName(basename(abs)), new Set(existing.map((f) => f.name)));
    const meta = { id: newId("f"), name, size, type: mimeFor(name), addedAt: Date.now(), from: fromId };
    await this.relay.putFile(this.jobId, meta, readFileSync(abs));
    await this.relay.emit({ jobId: this.jobId, agentId: fromId, type: "artifact", payload: { kind: "file", fileId: meta.id, name, size, note } });
    return `Shared ${name}. The user sees it in the chat as a download.`;
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

const MIME: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};

function mimeFor(name: string): string {
  return MIME[name.split(".").pop()?.toLowerCase() ?? ""] ?? "application/octet-stream";
}
