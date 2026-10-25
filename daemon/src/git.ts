import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { branchFor } from "@wdash/shared";

const run = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout.trimEnd();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    throw new GitError(`git ${args.join(" ")} failed: ${err.stderr || err.message}`, err.stderr ?? "");
  }
}

export async function tryGit(cwd: string, ...args: string[]): Promise<string | undefined> {
  try {
    return await git(cwd, ...args);
  } catch {
    return undefined;
  }
}

async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await tryGit(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)) !== undefined;
}

export async function fetchAll(repo: string): Promise<void> {
  await tryGit(repo, "fetch", "--prune", "origin");
}

/**
 * Make sure `branch` exists locally: prefer an existing local branch, then origin/<branch>,
 * otherwise create it from `from`.
 */
async function ensureBranch(repo: string, branch: string, from: string): Promise<void> {
  if (await refExists(repo, `refs/heads/${branch}`)) return;
  if (await refExists(repo, `refs/remotes/origin/${branch}`)) {
    await git(repo, "branch", branch, `origin/${branch}`);
    return;
  }
  await git(repo, "branch", branch, from);
}

export async function addWorktree(repo: string, path: string, branch: string, from: string): Promise<string> {
  await ensureBranch(repo, branch, from);
  if (existsSync(join(path, ".git"))) return path;
  mkdirSync(join(path, ".."), { recursive: true });
  await tryGit(repo, "worktree", "prune");
  await git(repo, "worktree", "add", path, branch);
  return path;
}

/** Adds a pattern to the repo's info/exclude (shared by all its worktrees), so it is never committed. */
export async function excludeFromGit(repo: string, pattern: string): Promise<void> {
  const common = await git(repo, "rev-parse", "--git-common-dir");
  const file = join(isAbsolute(common) ? common : join(repo, common), "info", "exclude");
  const current = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (current.split(/\r?\n/).includes(pattern)) return;
  mkdirSync(join(file, ".."), { recursive: true });
  appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${pattern}\n`);
}

export async function removeWorktree(repo: string, path: string): Promise<void> {
  await tryGit(repo, "worktree", "remove", "--force", path);
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

/** Base ref for a new job: local base branch at home (may have unpushed work), origin/<base> in the cloud. */
export async function baseRef(repo: string, baseBranch: string, mode: "home" | "cloud"): Promise<string> {
  if (mode === "home" && (await refExists(repo, `refs/heads/${baseBranch}`))) return baseBranch;
  if (await refExists(repo, `refs/remotes/origin/${baseBranch}`)) return `origin/${baseBranch}`;
  return "HEAD";
}

/** Never committed by checkpoints: installs and build output are huge and break pushes. */
export const NEVER_COMMIT = ["/.wdash/", "node_modules/", ".next/"];
/** GitHub rejects a whole push if any file is over 100 MB. */
const MAX_FILE_BYTES = 95 * 1024 * 1024;

/** The useful part of a git failure: the last lines of stderr, not the (long) command line. */
export function gitErrorTail(e: unknown, lines = 4): string {
  const err = e as Partial<GitError> & Error;
  const text = (err.stderr || err.message || String(e)).trim();
  return text.split("\n").filter(Boolean).slice(-lines).join(" | ").slice(0, 500);
}

/** WIP commit of everything in the worktree. Returns the new sha, or undefined if nothing changed. */
export async function checkpointCommit(worktree: string, message: string): Promise<string | undefined> {
  await git(worktree, "add", "-A");
  let staged = await git(worktree, "diff", "--cached", "--name-only", "--diff-filter=AM");
  for (const f of staged.split("\n").filter(Boolean)) {
    const p = join(worktree, f);
    if (existsSync(p) && statSync(p).size > MAX_FILE_BYTES) {
      await git(worktree, "rm", "--cached", "--quiet", "--", f);
      await excludeFromGit(worktree, `/${f}`);
    }
  }
  staged = await git(worktree, "diff", "--cached", "--name-only");
  if (!staged) return undefined;
  await git(worktree, "commit", "-m", message);
  return git(worktree, "rev-parse", "HEAD");
}

export async function pushBranches(repo: string, branches: string[]): Promise<void> {
  if (!branches.length) return;
  await git(repo, "push", "origin", ...branches.map((b) => `refs/heads/${b}:refs/heads/${b}`));
}

/**
 * Push branches one at a time, so one bad branch (GitHub rejects the whole push if any file is too big)
 * doesn't keep the others from being saved. Returns the branches that failed, with the reason.
 */
export async function pushEach(repo: string, branches: string[]): Promise<Array<{ branch: string; why: string }>> {
  const failed: Array<{ branch: string; why: string }> = [];
  for (const b of branches) {
    try {
      await git(repo, "push", "origin", `refs/heads/${b}:refs/heads/${b}`);
    } catch (e) {
      failed.push({ branch: b, why: gitErrorTail(e, 3) });
    }
  }
  return failed;
}

/** Push the PC checkout's base branch to GitHub after a merge. Returns an error message instead of throwing. */
export async function pushBase(localPath: string, baseBranch: string): Promise<string | undefined> {
  try {
    await git(localPath, "push", "origin", `refs/heads/${baseBranch}:refs/heads/${baseBranch}`);
    return undefined;
  } catch (e) {
    const msg = (e as GitError).stderr || (e as Error).message;
    return /rejected|non-fast-forward|fetch first/i.test(msg)
      ? `GitHub's ${baseBranch} has commits your PC doesn't; pull them, then push.`
      : msg.trim().split("\n").slice(-2).join(" ").slice(0, 300);
  }
}

export async function head(worktree: string): Promise<string> {
  return git(worktree, "rev-parse", "HEAD");
}

export type DiffResult = { base: string; files: Array<{ status: string; path: string }>; stat: string; patch: string };

export async function diffAgainst(worktree: string, against: string, maxBytes = 400_000): Promise<DiffResult> {
  const base = (await tryGit(worktree, "merge-base", against, "HEAD")) ?? against;
  const nameStatus = await git(worktree, "diff", "--name-status", base, "HEAD");
  const stat = await git(worktree, "diff", "--stat", base, "HEAD");
  let patch = await git(worktree, "diff", base, "HEAD");
  if (patch.length > maxBytes) patch = `${patch.slice(0, maxBytes)}\n… diff truncated (${patch.length} bytes)`;
  const files = nameStatus
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status: status ?? "?", path: rest.join(" -> ") };
    });
  return { base, files, stat, patch };
}

/** Merge `branch` into the worktree's current branch. On conflict, aborts and returns conflicting paths. */
export async function mergeInto(worktree: string, branch: string, message: string): Promise<{ ok: true } | { ok: false; conflicts: string[] }> {
  try {
    await git(worktree, "merge", "--no-ff", "-m", message, branch);
    return { ok: true };
  } catch {
    const conflicts = ((await tryGit(worktree, "diff", "--name-only", "--diff-filter=U")) ?? "").split("\n").filter(Boolean);
    await tryGit(worktree, "merge", "--abort");
    return { ok: false, conflicts };
  }
}

export type SyncOutcome =
  | { kind: "merged"; sha: string }
  | { kind: "needs_merge"; why: string; conflicts?: string[] }
  | { kind: "missing" };

/**
 * Sync a finished job branch into the user's own checkout on the home PC (SPEC.md §10):
 * merge automatically only if the checkout is on the base branch, clean, and the merge is clean.
 */
export async function syncIntoCheckout(localPath: string, baseBranch: string, jobId: string): Promise<SyncOutcome> {
  await fetchAll(localPath);
  const branch = branchFor.main(jobId);
  const ref = (await refExists(localPath, `refs/remotes/origin/${branch}`))
    ? `origin/${branch}`
    : (await refExists(localPath, `refs/heads/${branch}`))
      ? branch
      : undefined;
  if (!ref) return { kind: "missing" };
  // Keep a local branch either way, so "leave as branch" always works.
  if (ref.startsWith("origin/")) await tryGit(localPath, "branch", "-f", branch, ref);

  const current = await git(localPath, "rev-parse", "--abbrev-ref", "HEAD");
  if (current !== baseBranch) return { kind: "needs_merge", why: `Your checkout is on '${current}', not '${baseBranch}'.` };
  const dirty = await git(localPath, "status", "--porcelain", "--untracked-files=no");
  if (dirty) return { kind: "needs_merge", why: "Your checkout has uncommitted changes." };
  // Pick up jobs that were merged on GitHub while the PC couldn't take them (mergeOnGitHub).
  if (await refExists(localPath, `refs/remotes/origin/${baseBranch}`)) await tryGit(localPath, "merge", "--ff-only", `origin/${baseBranch}`);

  try {
    await git(localPath, "merge", "--no-edit", branch);
    return { kind: "merged", sha: await head(localPath) };
  } catch {
    const conflicts = ((await tryGit(localPath, "diff", "--name-only", "--diff-filter=U")) ?? "").split("\n").filter(Boolean);
    await tryGit(localPath, "merge", "--abort");
    return { kind: "needs_merge", why: "Merge conflicts with your local branch.", conflicts };
  }
}

/**
 * Merge a finished job into the base branch on GitHub, with no PR and no PC checkout: merge origin/<base>
 * into the job worktree, then push it as the new base (a fast-forward). Used for cloud jobs and when the
 * PC checkout can't take the merge. Retries if someone else pushed in between.
 */
export async function mergeOnGitHub(worktree: string, baseBranch: string): Promise<SyncOutcome> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await tryGit(worktree, "fetch", "origin", baseBranch);
    if (await refExists(worktree, `refs/remotes/origin/${baseBranch}`)) {
      const res = await mergeInto(worktree, `origin/${baseBranch}`, `wdash: merge ${baseBranch} into job branch`);
      if (!res.ok) return { kind: "needs_merge", why: `Merge conflicts with ${baseBranch} on GitHub.`, conflicts: res.conflicts };
    }
    try {
      await git(worktree, "push", "origin", `HEAD:refs/heads/${baseBranch}`);
      return { kind: "merged", sha: await head(worktree) };
    } catch (e) {
      const msg = (e as GitError).stderr || (e as Error).message;
      if (!/rejected|non-fast-forward|fetch first/i.test(msg)) {
        return { kind: "needs_merge", why: `Couldn't push to ${baseBranch} on GitHub: ${msg.trim().split("\n").slice(-2).join(" ").slice(0, 300)}` };
      }
    }
  }
  return { kind: "needs_merge", why: `${baseBranch} on GitHub kept changing while merging; try again.` };
}
