import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// SPEC.md §6.2 — the shared board, exposed to agents as in-process MCP tools (mcp__wdash__*).

export type PlannedWorker = { name: string; task: string; globs: string[] };

/** Operations the board tools call. Implemented by JobRunner; each returns text for the model. */
export interface TeamApi {
  // everyone
  post(fromId: string, to: string, text: string): Promise<string>;
  // orchestrator
  submitPlan(summary: string, workers: PlannedWorker[]): Promise<string>;
  spawnWorker(w: PlannedWorker): Promise<string>;
  grantFiles(agentId: string, globs: string[]): Promise<string>;
  denyFiles(agentId: string, reason: string): Promise<string>;
  reviewDiff(agentId: string): Promise<string>;
  requestChanges(agentId: string, notes: string): Promise<string>;
  approve(agentId: string): Promise<string>;
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

const globs = z.array(z.string().min(1)).min(1).describe("Path globs relative to the repo root, posix style, e.g. src/solver/**");
const workerShape = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/).describe("Short id like 'solver' or 'tests'"),
  task: z.string().min(1).describe("What this worker must do, with acceptance criteria"),
  globs,
});

export function orchestratorServer(api: TeamApi, selfId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "wdash",
    version: "0.1.0",
    tools: [
      tool(
        "team_plan",
        "Submit the plan: split the task across 1-4 workers, each owning non-overlapping path globs. Plans with 3+ workers wait for the user's approval; smaller plans start immediately.",
        { summary: z.string().min(1), workers: z.array(workerShape).min(1).max(4) },
        (a) => wrap(() => api.submitPlan(a.summary, a.workers)),
      ),
      tool("team_spawn_worker", "Add one more worker after the plan has started.", workerShape.shape, (a) => wrap(() => api.spawnWorker(a))),
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

/** Chat agents work alone: no board tools. */
export function chatServer(): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: "wdash", version: "0.1.0", tools: [] });
}

export function workerServer(api: TeamApi, selfId: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "wdash",
    version: "0.1.0",
    tools: [
      tool(
        "board_post",
        "Send a message to the orchestrator ('orchestrator'), another worker (by name) or 'all'.",
        { to: z.string(), text: z.string().min(1) },
        (a) => wrap(() => api.post(selfId, a.to, a.text)),
      ),
      tool(
        "board_request_files",
        "Ask the orchestrator for ownership of paths you need to edit.",
        { globs, reason: z.string().min(1) },
        (a) => wrap(() => api.requestFiles(selfId, a.globs, a.reason)),
      ),
      tool(
        "board_report_done",
        "Report your task finished. Your work is committed, checks run automatically, and the orchestrator reviews it.",
        { summary: z.string().min(1) },
        (a) => wrap(() => api.reportDone(selfId, a.summary)),
      ),
      tool("sync_with_main", "Merge the latest job branch (other workers' approved work) into your branch.", {}, () =>
        wrap(() => api.syncWithMain(selfId)),
      ),
    ],
  });
}
