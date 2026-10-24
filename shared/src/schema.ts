import { z } from "zod";

// ---------- Projects ----------

export const ProjectConfig = z.object({
  name: z.string().regex(/^[a-zA-Z0-9._-]+$/),
  repo: z.string().regex(/^[^/\s]+\/[^/\s]+$/), // "owner/name"
  baseBranch: z.string().default("main"),
  /** Absolute path on the home PC. Never used by the cloud runner. */
  localPath: z.string().optional(),
  commands: z
    .object({
      install: z.string().optional(),
      build: z.string().optional(),
      test: z.string().optional(),
      /** Command that writes a PNG to $WDASH_SCREENSHOT (UI projects). */
      screenshot: z.string().optional(),
    })
    .default({}),
  defaultBudgetUsd: z.number().positive().default(5),
  /** Whether a GitHub Actions caller workflow is installed in the repo. */
  cloud: z.boolean().default(true),
  /** After finished work merges into the PC checkout, push the base branch to GitHub. */
  pushOnMerge: z.boolean().default(true),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** Project name for chats that aren't tied to a repo: the agent works in an empty scratch folder. */
export const NO_PROJECT = "_scratch";

export function scratchProject(): ProjectConfig {
  return ProjectConfig.parse({ name: NO_PROJECT, repo: "none/none", baseBranch: "main", commands: {}, defaultBudgetUsd: 2, cloud: true, pushOnMerge: false });
}

export function projectLabel(name: string): string {
  return name === NO_PROJECT ? "no project" : name;
}

// ---------- Jobs ----------

export const JobStatus = z.enum([
  "queued",
  "planning",
  "awaiting_plan_approval",
  "running",
  "waiting_on_user",
  "reviewing",
  "merging",
  "paused",
  "over_budget",
  "done",
  "failed",
  "cancelled",
]);
export type JobStatus = z.infer<typeof JobStatus>;

export const TERMINAL_STATUSES: JobStatus[] = ["done", "failed", "cancelled"];

export const JobLocation = z.enum(["queued", "home", "cloud", "migrating"]);
export type JobLocation = z.infer<typeof JobLocation>;

export const RunOn = z.enum(["auto", "home", "cloud"]);

export const MergeState = z.enum(["none", "pending", "merged", "needs_merge", "left_as_branch", "discarded"]);

export const ModelPreset = z.enum(["opus-sonnet", "opus-opus", "sonnet-haiku"]);
export type ModelPreset = z.infer<typeof ModelPreset>;

export const MODEL_PRESETS: Record<ModelPreset, { orchestrator: string; worker: string; label: string }> = {
  "opus-sonnet": { orchestrator: "opus", worker: "sonnet", label: "Opus orchestrator + Sonnet workers" },
  "opus-opus": { orchestrator: "opus", worker: "opus", label: "Opus everywhere" },
  "sonnet-haiku": { orchestrator: "sonnet", worker: "haiku", label: "Sonnet orchestrator + Haiku workers" },
};

/** "team": orchestrator + workers + review. "chat": one agent you talk to directly in the project's repo. */
export const JobKind = z.enum(["team", "chat"]);
export type JobKind = z.infer<typeof JobKind>;

export const ChatModel = z.enum(["opus", "sonnet", "haiku"]);
export type ChatModel = z.infer<typeof ChatModel>;

/** Agent id of a chat job's single agent. */
export const CHAT_AGENT = "claude";

/** Most workers a job can have, helpers included. */
export const MAX_WORKERS = 15;
export const WORKER_CHOICES = ["auto", ...Array.from({ length: MAX_WORKERS }, (_, i) => String(i + 1))] as [string, ...string[]];

const num = z.coerce.number();
const bool = z.preprocess((v) => v === true || v === "true" || v === "1", z.boolean());

export const JobRecord = z.object({
  id: z.string(),
  project: z.string(),
  task: z.string(),
  title: z.string(),
  status: JobStatus,
  location: JobLocation,
  kind: JobKind.default("team"),
  chatModel: ChatModel.default("sonnet"),
  runOn: RunOn.default("auto"),
  models: ModelPreset.default("sonnet-haiku"),
  workers: z.string().default("auto"), // "auto" | "1".."15"
  budgetUsd: num,
  reviewCap: num.default(3),
  costUsd: num.default(0),
  /** Tokens across all agents: input incl. cache reads/writes, and output. */
  tokensIn: num.default(0),
  tokensOut: num.default(0),
  createdAt: num,
  updatedAt: num,
  summary: z.string().optional(),
  error: z.string().optional(),
  lastCheckpointSha: z.string().optional(),
  cloudRunUrl: z.string().optional(),
  dispatchedAt: num.optional(),
  /** Last command-stream id the daemon handled, so a new runner continues where the last left off. */
  cmdCursor: z.string().optional(),
  mergeState: MergeState.default("none"),
  archived: bool.default(false),
  /** Approve permission requests automatically (hard denies still apply; questions still go to the user). */
  autoMode: bool.default(false),
  /** Low usage mode: fewer tools, low effort, short prompts, one worker and one review round. */
  lite: bool.default(false),
  /** A finished job the user reopened with a follow-up message; the runner tells the agents, then clears it. */
  reopened: bool.default(false),
});
export type JobRecord = z.infer<typeof JobRecord>;

/** Built-in tools agents get in low usage mode. Every tool definition is resent each turn, and subagents multiply usage. */
export const LITE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "AskUserQuestion"];
/** Low usage mode caps the project CLAUDE.md appended to each agent's system prompt at this many characters. */
export const LITE_NOTES_CHARS = 3000;

// ---------- Attachments ----------

/** Per file. Vercel caps request bodies at 4.5 MB, and the contents are stored base64 in Redis. */
export const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
/** Where the daemon puts attachments, relative to each agent's worktree. Git-excluded, never committed. */
export const ATTACHMENTS_DIR = ".wdash/attachments";

export const Attachment = z.object({
  id: z.string(),
  /** Safe file name, unique within the job. */
  name: z.string(),
  size: z.number(),
  type: z.string().default("application/octet-stream"),
  addedAt: z.number(),
  /** Agent id when an agent shared it (share_file); absent for the user's uploads. */
  from: z.string().optional(),
});
export type Attachment = z.infer<typeof Attachment>;

/** Strip path parts and characters that are awkward on Windows or in shells. */
export function safeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^[.\s]+/, "").trim().slice(0, 120);
  return cleaned || "file";
}

/** `name`, or `name (2).ext`, … so it doesn't collide with `taken`. */
export function uniqueFileName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; ; i++) {
    const n = `${stem} (${i})${ext}`;
    if (!taken.has(n)) return n;
  }
}

export const NewJobInput = z.object({
  project: z.string().min(1),
  task: z.string().min(1).max(20_000),
  kind: JobKind.default("team"),
  chatModel: ChatModel.default("sonnet"),
  runOn: RunOn.default("auto"),
  models: ModelPreset.default("sonnet-haiku"),
  workers: z.enum(WORKER_CHOICES).default("auto"),
  budgetUsd: z.number().positive().max(500).optional(),
  reviewCap: z.number().int().min(1).max(10).default(3),
  autoMode: z.boolean().default(false),
  lite: z.boolean().default(false),
  /** Upload ids from POST /api/uploads. */
  attachments: z.array(z.string()).max(MAX_ATTACHMENTS).default([]),
});
export type NewJobInput = z.infer<typeof NewJobInput>;

// ---------- Agents ----------

export const AgentRole = z.enum(["orchestrator", "worker", "chat"]);
export const AgentStatus = z.enum([
  "starting",
  "running",
  "idle",
  "waiting_on_user",
  "waiting_on_approval",
  "reviewing",
  "done",
  "failed",
  "stopped",
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const AgentRecord = z.object({
  id: z.string(),
  role: AgentRole,
  model: z.string(),
  name: z.string(),
  task: z.string().default(""),
  globs: z.array(z.string()).default([]),
  status: AgentStatus,
  sessionId: z.string().optional(),
  branch: z.string().optional(),
  reviewRounds: z.number().default(0),
  lastEventAt: z.number().default(0),
  costUsd: z.number().default(0),
});
export type AgentRecord = z.infer<typeof AgentRecord>;

// ---------- Events (daemon -> UI) ----------

export const EventType = z.enum([
  "message",
  "tool_call",
  "tool_result",
  "permission_request",
  "permission_decision",
  "question",
  "plan",
  "board",
  "review",
  "artifact",
  "diff",
  "status",
  "usage",
  "checkpoint",
  "attention",
  "attention_cleared",
  "error",
  "info",
]);
export type EventType = z.infer<typeof EventType>;

export const WdEvent = z.object({
  id: z.string().optional(), // stream id, filled on read
  ts: z.number(),
  jobId: z.string(),
  agentId: z.string().optional(),
  /** Subagent (Explore/Plan/…) id inside an agent, for the nested tree. */
  subagentId: z.string().optional(),
  subagentType: z.string().optional(),
  type: EventType,
  payload: z.record(z.string(), z.unknown()),
});
export type WdEvent = z.infer<typeof WdEvent>;

// ---------- Commands (UI -> daemon) ----------

export const Command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    text: z.string().min(1).max(20_000),
    agentId: z.string().optional(),
    /** Ids of files already added to the job (POST /api/jobs/:id/files). */
    attachments: z.array(z.string()).max(MAX_ATTACHMENTS).optional(),
  }),
  z.object({
    type: z.literal("decide"),
    requestId: z.string(),
    allow: z.boolean(),
    scope: z.enum(["once", "job"]).default("once"),
    message: z.string().max(2000).optional(),
  }),
  z.object({
    type: z.literal("answer"),
    requestId: z.string(),
    answers: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal("approve_plan"), edits: z.string().max(10_000).optional() }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("resume") }),
  z.object({ type: z.literal("raise_budget"), budgetUsd: z.number().positive().max(500) }),
  z.object({ type: z.literal("retry_agent"), agentId: z.string() }),
  z.object({ type: z.literal("nudge"), agentId: z.string(), text: z.string().max(2000).optional() }),
  z.object({ type: z.literal("accept_review"), agentId: z.string() }),
  z.object({ type: z.literal("guidance"), agentId: z.string(), text: z.string().min(1).max(10_000) }),
  /** Chat jobs: commit the agent's changes and merge them like a finished job. */
  z.object({ type: z.literal("finish_chat") }),
  /** Turn auto mode on/off; turning it on also allows the requests already waiting. */
  z.object({ type: z.literal("set_auto_mode"), enabled: z.boolean() }),
]);
export type Command = z.infer<typeof Command>;

// ---------- New projects (web -> home daemon) ----------

export const NewProjectInput = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[A-Za-z0-9._-]+$/, "Use letters, digits, '.', '_' or '-'")
    .refine((n) => !n.startsWith("."), "Can't start with '.'")
    .refine((n) => n !== NO_PROJECT, "That name is reserved"),
  description: z.string().max(300).optional(),
  testCommand: z.string().max(300).optional(),
  buildCommand: z.string().max(300).optional(),
});
export type NewProjectInput = z.infer<typeof NewProjectInput>;

export const ProjectRequest = z.object({
  id: z.string(),
  input: NewProjectInput,
  status: z.enum(["pending", "creating", "done", "failed"]),
  error: z.string().optional(),
  project: z.string().optional(),
  /** Set when the website already created the GitHub repo; the PC only clones and registers it. */
  repo: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ProjectRequest = z.infer<typeof ProjectRequest>;

// ---------- Approvals ----------

export const Approval = z.object({
  requestId: z.string(),
  jobId: z.string(),
  agentId: z.string(),
  kind: z.enum(["permission", "question"]),
  tool: z.string(),
  input: z.record(z.string(), z.unknown()),
  title: z.string(),
  status: z.enum(["pending", "allowed", "denied", "answered", "expired"]),
  createdAt: z.number(),
  decidedAt: z.number().optional(),
});
export type Approval = z.infer<typeof Approval>;

// ---------- Usage ----------

export const RateLimitInfo = z.object({
  status: z.string(),
  rateLimitType: z.string().optional(),
  utilization: z.number().optional(),
  resetsAt: z.number().optional(),
  updatedAt: z.number(),
});
export type RateLimitInfo = z.infer<typeof RateLimitInfo>;

// ---------- Push ----------

export const PushSubscriptionJson = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
