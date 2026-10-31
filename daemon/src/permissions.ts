import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";
import type { ProjectConfig } from "@wdash/shared";

// SPEC.md §8. Pure policy so it can be unit tested; the daemon wires it into canUseTool.

export type PolicyContext = {
  role: "orchestrator" | "lead" | "worker" | "chat";
  agentId: string;
  /** Directory the agent works in (its git worktree). */
  root: string;
  /** Globs (relative to root, posix style) this agent may edit. */
  owned: string[];
  /** All claims in the job: glob -> agent id. Used to name the owner in denials. */
  claims: Record<string, string>;
  commands: ProjectConfig["commands"];
  /** Rules the user allowed for the whole job, e.g. "Bash:npm run lint". */
  jobRules: string[];
  platform?: NodeJS.Platform;
};

export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; message: string }
  | { kind: "ask"; rule: string; title: string }
  | { kind: "question" };

const READ_ONLY_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "TodoWrite",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "TaskStop",
  "ToolSearch",
  "Agent",
  "Task",
  "Skill",
  "LSP",
]);

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const NETWORK_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Tools that never make sense inside wdash agents. Passed as disallowedTools too. */
export const DISALLOWED_TOOLS = [
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "RemoteTrigger",
  "ScheduleWakeup",
  "PushNotification",
  "Artifact",
  "SendUserFile",
  "Monitor",
  "EnterPlanMode",
  "ExitPlanMode",
];

// Shell commands that only read state. Matched against the whole (trimmed) command.
const SAFE_SHELL = [
  /^git (status|diff|log|show|branch|rev-parse|ls-files|blame)( [^;&|`$<>]*)?$/,
  /^(ls|dir|pwd|cat|head|tail|wc|type)( [^;&|`$<>]*)?$/,
];

export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  if (tool === "AskUserQuestion") return { kind: "question" };
  if (tool.startsWith("mcp__wdash__")) return { kind: "allow" };
  if (DISALLOWED_TOOLS.includes(tool)) return { kind: "deny", message: `${tool} is not available inside wdash.` };

  if (READ_ONLY_TOOLS.has(tool)) {
    const p = pathArg(input);
    if (p && !inside(ctx.root, p, ctx.platform)) return { kind: "deny", message: `Path is outside the project: ${p}` };
    return { kind: "allow" };
  }

  if (EDIT_TOOLS.has(tool)) {
    const p = pathArg(input);
    if (!p) return { kind: "deny", message: "Edit without a file path." };
    if (!inside(ctx.root, p, ctx.platform)) return { kind: "deny", message: `Path is outside your worktree: ${p}` };
    const rel = toPosix(relative(ctx.root, resolve(ctx.root, p)));
    if (ctx.role === "orchestrator" || ctx.role === "lead") {
      return {
        kind: "deny",
        message: `The ${ctx.role} doesn't edit files. Spawn a worker (team_spawn_worker) that owns this path.`,
      };
    }
    if (ownsPath(ctx.owned, rel)) return { kind: "allow" };
    // Another GitHub repo the agent opened with open_repo: outside the project's ownership rules.
    if (rel.startsWith(".wdash/repos/")) return { kind: "allow" };
    const owner = ownerOf(ctx.claims, rel);
    return {
      kind: "deny",
      message: owner
        ? `${rel} is owned by ${owner}. Ask for it with board_request_files or message ${owner} via board_post.`
        : `${rel} isn't assigned to you. Ask the orchestrator with board_request_files.`,
    };
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(input.command ?? "").trim();
    const rule = `${tool}:${cmd}`;
    if (!cmd) return { kind: "deny", message: "Empty command." };
    const configured = Object.values(ctx.commands).filter((c): c is string => !!c);
    if (configured.some((c) => c.trim() === cmd)) return { kind: "allow" };
    if (SAFE_SHELL.some((re) => re.test(cmd))) return { kind: "allow" };
    if (ctx.jobRules.includes(rule)) return { kind: "allow" };
    const title = /\bgit\s+push\b/.test(cmd) ? `git push: ${cmd}` : `Run: ${cmd}`;
    return { kind: "ask", rule, title };
  }

  // Reading links and searching only read, and the user wants agents to follow the links they give.
  if (NETWORK_TOOLS.has(tool)) return { kind: "allow" };

  // Unknown or third-party MCP tools: ask.
  const rule = `${tool}:*`;
  if (ctx.jobRules.includes(rule)) return { kind: "allow" };
  return { kind: "ask", rule, title: `Use tool ${tool}` };
}

export function ownsPath(globs: string[], rel: string): boolean {
  return globs.some((g) => minimatch(rel, g, { dot: true }) || minimatch(rel, `${g.replace(/\/$/, "")}/**`, { dot: true }));
}

export function ownerOf(claims: Record<string, string>, rel: string): string | undefined {
  for (const [g, owner] of Object.entries(claims)) if (ownsPath([g], rel)) return owner;
  return undefined;
}

/** Globs in `wanted` that overlap something already claimed by another agent. */
export function conflictingClaims(claims: Record<string, string>, wanted: string[], agentId: string): string[] {
  const out: string[] = [];
  for (const w of wanted) {
    for (const [g, owner] of Object.entries(claims)) {
      if (owner === agentId) continue;
      if (globsOverlap(w, g)) out.push(`${w} (overlaps ${g} owned by ${owner})`);
    }
  }
  return out;
}

/** Conservative overlap check: same glob, or one's literal prefix contains the other. */
export function globsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const pa = literalPrefix(a);
  const pb = literalPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

function literalPrefix(g: string): string {
  const i = g.search(/[*?[{]/);
  return i === -1 ? g : g.slice(0, i);
}

function pathArg(input: Record<string, unknown>): string | undefined {
  const v = input.file_path ?? input.notebook_path ?? input.path;
  return typeof v === "string" && v.length ? v : undefined;
}

export function inside(root: string, p: string, platform: NodeJS.Platform = process.platform): boolean {
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const norm = (s: string) => (platform === "win32" ? s.toLowerCase() : s);
  const r = norm(resolve(root));
  const a = norm(abs);
  return a === r || a.startsWith(r.endsWith(sep) ? r : r + sep);
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}
