import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { MAX_WORKERS } from "@wdash/shared";

// SPEC.md §6.2 — the shared board, exposed to agents as in-process MCP tools (mcp__wdash__*).

/**
 * `helps`: a slow worker this one takes part of the work from (its globs may overlap that worker's).
 * `lead`: a middle-tier agent (orchestrator plans only) that splits its globs among its own workers.
 */
export type PlannedWorker = { name: string; task: string; globs: string[]; helps?: string; lead?: boolean };

/** Operations the board tools call. Implemented by JobRunner; each returns text for the model. */
export interface TeamApi {
  // everyone
  post(fromId: string, to: string, text: string): Promise<string>;
  shareFile(fromId: string, path: string, note?: string): Promise<string>;
  openRepo(fromId: string, repo: string): Promise<string>;
  pushRepo(fromId: string, repo: string, message: string): Promise<string>;
  vercelDeploy(fromId: string, path: string, project: string | undefined, production: boolean): Promise<string>;
  usageQuote(): Promise<string>;
  // orchestrator, and leads for their own workers (`by`: who is acting; defaults to the orchestrator)
  submitPlan(summary: string, workers: PlannedWorker[]): Promise<string>;
  spawnWorker(w: PlannedWorker, by?: string): Promise<string>;
  grantFiles(agentId: string, globs: string[], by?: string): Promise<string>;
  denyFiles(agentId: string, reason: string, by?: string): Promise<string>;
  reviewDiff(agentId: string, by?: string): Promise<string>;
  requestChanges(agentId: string, notes: string, by?: string): Promise<string>;
  approve(agentId: string, by?: string): Promise<string>;
  finalCheck(): Promise<string>;
  finish(summary: string): Promise<string>;
  // worker
  requestFiles(fromId: string, globs: string[], reason: string): Promise<string>;
  reportDone(fromId: string, summary: string): Promise<string>;
  syncWithMain(fromId: string): Promise<string>;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${(e as Error).message ?? String(e)}` }], isError: true });

async function wrap(fn: () => Promise<string>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

/** Lets any agent hand the user a file; it shows in the chat as a download. */
function shareTool(api: TeamApi, selfId: string) {
  return tool(
    "share_file",
    "Put a file from your working directory into the chat so the user can download it (reports, documents, images, data, exports). Up to 4 MB. Use it whenever the user asks for a file or a file is the deliverable.",
    {
      path: z.string().min(1).describe("Path relative to your working directory, e.g. docs/report.md"),
      note: z.string().max(500).optional().describe("One line shown with the file"),
    },
    (a) => wrap(() => api.shareFile(selfId, a.path, a.note)),
  );
}

/** Numbers for estimating what a job will use, so the agent can give the user a quote. */
function quoteTool(api: TeamApi) {
  return tool(
    "usage_quote",
    "Get the numbers for a usage estimate: what this job has used so far, what similar past jobs cost (API-equivalent $, tokens, minutes, workers), how far through the Claude subscription limits the user is, and Kaggle hours left. Call it before quoting the user a cost.",
    {},
    () => wrap(() => api.usageQuote()),
  );
}

/** Editing a different GitHub repo than the job's project; changes push straight to its default branch. */
function repoTools(api: TeamApi, selfId: string) {
  const repo = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).describe("GitHub repo as owner/name, e.g. yoda-3x3/day_tradr");
  return [
    tool(
      "open_repo",
      "Clone another GitHub repo (not this job's project) so you can edit its files. Returns the folder to edit in. Call it again to pull the latest.",
      { repo },
      (a) => wrap(() => api.openRepo(selfId, a.repo)),
    ),
    tool(
      "push_repo",
      "Commit everything you changed in a repo opened with open_repo and push it straight to that repo's default branch.",
      { repo, message: z.string().min(1).max(300).describe("Commit message") },
      (a) => wrap(() => api.pushRepo(selfId, a.repo, a.message)),
    ),
  ];
}

/** Deploy a folder to Vercel and get its URL. Not for workers: their work isn't reviewed yet. */
function deployTool(api: TeamApi, selfId: string) {
  return tool(
    "vercel_deploy",
    "Deploy a folder to Vercel and get its live URL (sites, web apps, APIs). Asks the user first unless auto mode is on. The Vercel project is created if it doesn't exist. Use it when the user asks to deploy, publish, or host something.",
    {
      path: z.string().default(".").describe("Folder relative to your working directory: '.' for this repo, or a repo opened with open_repo"),
      project: z
        .string()
        .max(100)
        .optional()
        .describe("Vercel project name; defaults to the project (or opened repo) name. Keep it the same across deploys of one app."),
      production: z.boolean().default(true).describe("false for a preview deployment that doesn't replace the live site"),
    },
    (a) => wrap(() => api.vercelDeploy(selfId, a.path, a.project, a.production)),
  );
}

const globs = z.array(z.string().min(1)).min(1).describe("Path globs relative to the repo root, posix style, e.g. src/solver/**");
const workerShape = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).describe("Short id like 'solver' or 'tests'"),
  task: z.string().min(1).describe("What this worker must do, with acceptance criteria"),
  globs,
  helps: z
    .string()
    .optional()
    .describe("Only when splitting a slow worker's work: that worker's name. The helper may take a subset of its paths."),
});
/** The orchestrator's plan items may be leads (3-tier); a lead's own workers may not. */
const planItemShape = workerShape.extend({
  lead: z
    .boolean()
    .optional()
    .describe(
      "true = a LEAD: it owns this broad area, splits it among its own workers, reviews and merges them, then reports to you. Use for areas needing 2+ parallel workers.",
    ),
});

export function orchestratorServer(api: TeamApi, selfId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "wdash",
    version: "0.1.0",
    tools: [
      shareTool(api, selfId),
      deployTool(api, selfId),
      quoteTool(api),
      tool(
        "team_plan",
        `Submit the plan: split the task across 1-${MAX_WORKERS} workers (or leads, lead: true), each owning non-overlapping path globs. Plans with 3+ items wait for the user's approval; smaller plans start immediately.`,
        { summary: z.string().min(1), workers: z.array(planItemShape).min(1).max(MAX_WORKERS) },
        (a) => wrap(() => api.submitPlan(a.summary, a.workers)),
      ),
      tool("team_spawn_worker", "Add one more worker (or lead, lead: true) after the plan has started.", planItemShape.shape, (a) => wrap(() => api.spawnWorker(a))),
      tool(
        "board_post",
        "Send a message to a worker (by name) or 'all'.",
        { to: z.string(), text: z.string().min(1) },
        (a) => wrap(() => api.post(selfId, a.to, a.text)),
      ),
      tool("board_grant_files", "Give a worker ownership of more paths.", { agent: z.string(), globs }, (a) => wrap(() => api.grantFiles(a.agent, a.globs))),
      tool(
        "board_deny_files",
        "Refuse a worker's file request.",
        { agent: z.string(), reason: z.string() },
        (a) => wrap(() => api.denyFiles(a.agent, a.reason)),
      ),
      tool("review_diff", "Get a worker's diff against the job branch plus its latest check results.", { agent: z.string() }, (a) =>
        wrap(() => api.reviewDiff(a.agent)),
      ),
      tool(
        "board_request_changes",
        "Send work back to a worker with specific notes. Counts as one review round.",
        { agent: z.string(), notes: z.string().min(1) },
        (a) => wrap(() => api.requestChanges(a.agent, a.notes)),
      ),
      tool("board_approve", "Approve a worker's work (requires its checks to pass) and merge it into the job branch.", { agent: z.string() }, (a) =>
        wrap(() => api.approve(a.agent)),
      ),
      tool("job_final_check", "Run build/test/screenshot checks on the combined job branch.", {}, () => wrap(() => api.finalCheck())),
      tool(
        "job_finish",
        "Finish the job with a report for the user. Requires every worker approved and a passing job_final_check on the current job branch.",
        { summary: z.string().min(1) },
        (a) => wrap(() => api.finish(a.summary)),
      ),
    ],
  });
}

/**
 * A lead (3-tier): a mini orchestrator for its own area. It spawns its own workers (paths inside its area),
 * reviews and merges them into its branch, then reports done to the orchestrator. It never edits files.
 */
export function leadServer(api: TeamApi, selfId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "wdash",
    version: "0.1.0",
    tools: [
      shareTool(api, selfId),
      quoteTool(api),
      tool(
        "team_spawn_worker",
        "Start one of YOUR workers. Its globs must be inside your own area and not overlap your other workers'. Its branch starts from yours.",
        workerShape.shape,
        (a) => wrap(() => api.spawnWorker(a, selfId)),
      ),
      tool(
        "board_post",
        "Send a message to the orchestrator ('orchestrator'), one of your workers (by name), or 'all'.",
        { to: z.string(), text: z.string().min(1) },
        (a) => wrap(() => api.post(selfId, a.to, a.text)),
      ),
      tool("board_grant_files", "Give one of your workers more paths from your area.", { agent: z.string(), globs }, (a) =>
        wrap(() => api.grantFiles(a.agent, a.globs, selfId)),
      ),
      tool("board_deny_files", "Refuse one of your workers' file requests.", { agent: z.string(), reason: z.string() }, (a) =>
        wrap(() => api.denyFiles(a.agent, a.reason, selfId)),
      ),
      tool(
        "board_request_files",
        "Ask the orchestrator for more paths for your area.",
        { globs, reason: z.string().min(1) },
        (a) => wrap(() => api.requestFiles(selfId, a.globs, a.reason)),
      ),
      tool("review_diff", "Get one of your workers' diff against your branch plus its latest check results.", { agent: z.string() }, (a) =>
        wrap(() => api.reviewDiff(a.agent, selfId)),
      ),
      tool(
        "board_request_changes",
        "Send a worker's work back with specific notes. Counts as one review round.",
        { agent: z.string(), notes: z.string().min(1) },
        (a) => wrap(() => api.requestChanges(a.agent, a.notes, selfId)),
      ),
      tool("board_approve", "Approve one of your workers (requires its checks to pass) and merge it into your branch.", { agent: z.string() }, (a) =>
        wrap(() => api.approve(a.agent, selfId)),
      ),
      tool(
        "board_report_done",
        "Report your whole area finished to the orchestrator (requires all your workers merged). Checks run on your branch; the orchestrator reviews it.",
        { summary: z.string().min(1) },
        (a) => wrap(() => api.reportDone(selfId, a.summary)),
      ),
      tool("sync_with_main", "Merge the latest job branch (other leads' approved work) into your branch.", {}, () =>
        wrap(() => api.syncWithMain(selfId)),
      ),
    ],
  });
}

/** Chat agents work alone: no board tools, just sharing files. */
export function chatServer(api: TeamApi, selfId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: "wdash", version: "0.1.0", tools: [shareTool(api, selfId), ...repoTools(api, selfId), deployTool(api, selfId), quoteTool(api)] });
}

export function workerServer(api: TeamApi, selfId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "wdash",
    version: "0.1.0",
    tools: [
      shareTool(api, selfId),
      ...repoTools(api, selfId),
      tool(
        "board_post",
        "Send a message to whoever reviews you (the orchestrator, or your lead), another worker (by name) or 'all'.",
        { to: z.string(), text: z.string().min(1) },
        (a) => wrap(() => api.post(selfId, a.to, a.text)),
      ),
      tool(
        "board_request_files",
        "Ask whoever reviews you (the orchestrator, or your lead) for ownership of paths you need to edit.",
        { globs, reason: z.string().min(1) },
        (a) => wrap(() => api.requestFiles(selfId, a.globs, a.reason)),
      ),
      tool(
        "board_report_done",
        "Report your task finished. Your work is committed, checks run automatically, and whoever reviews you (orchestrator or lead) reviews it.",
        { summary: z.string().min(1) },
        (a) => wrap(() => api.reportDone(selfId, a.summary)),
      ),
      tool("sync_with_main", "Merge the latest approved work into your branch (the job branch, or your lead's branch if you have a lead).", {}, () =>
        wrap(() => api.syncWithMain(selfId)),
      ),
    ],
  });
}
