import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.js";

/** Other repos an agent opens live here, inside its working directory (git-excluded via /.wdash/). */
export const OTHER_REPOS_DIR = ".wdash/repos";

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** In the cloud the runner has a token; at home git uses the PC's own credentials. */
function remote(repo: string): string {
  const token = process.env.WDASH_PROJECTS_TOKEN;
  return token ? `https://x-access-token:${token}@github.com/${repo}.git` : `https://github.com/${repo}.git`;
}

/** Never let a token reach the model or the timeline. */
function scrub(msg: string): string {
  const token = process.env.WDASH_PROJECTS_TOKEN;
  return (token ? msg.split(token).join("***") : msg).replace(/x-access-token:[^@\s]+@/g, "x-access-token:***@").slice(0, 600);
}

export function repoDir(cwd: string, repo: string): string {
  return join(cwd, OTHER_REPOS_DIR, repo.replace("/", "__"));
}

/** Clone (or update) another GitHub repo for editing. Returns its path. */
export async function openRepo(cwd: string, repo: string): Promise<string> {
  if (!REPO.test(repo)) throw new Error(`"${repo}" isn't owner/name.`);
  const dir = repoDir(cwd, repo);
  try {
    if (existsSync(join(dir, ".git"))) {
      await git(dir, "pull", "--rebase", "--autostash");
    } else {
      mkdirSync(join(cwd, OTHER_REPOS_DIR), { recursive: true });
      await git(cwd, "clone", "--depth", "50", remote(repo), dir);
      // Cloud runners set a global identity; this is a last resort. Use the owner's own noreply address so
      // GitHub and Vercel credit the account (Vercel Hobby blocks deploys of commits by other authors).
      const owner = process.env.GITHUB_REPOSITORY_OWNER ?? repo.split("/")[0];
      if (!(await git(dir, "config", "user.email").catch(() => "")) && owner) {
        const id = process.env.GITHUB_REPOSITORY_OWNER_ID;
        await git(dir, "config", "user.name", owner);
        await git(dir, "config", "user.email", `${id ? `${id}+` : ""}${owner}@users.noreply.github.com`);
      }
    }
  } catch (e) {
    throw new Error(`Couldn't open ${repo}: ${scrub((e as Error).message)}`);
  }
  return dir;
}

/** Commit everything changed in an opened repo and push it straight to its default branch. */
export async function pushRepo(cwd: string, repo: string, message: string): Promise<string> {
  if (!REPO.test(repo)) throw new Error(`"${repo}" isn't owner/name.`);
  const dir = repoDir(cwd, repo);
  if (!existsSync(join(dir, ".git"))) throw new Error(`${repo} isn't open; call open_repo first.`);
  try {
    await git(dir, "add", "-A");
    const staged = await git(dir, "diff", "--cached", "--name-only");
    if (staged) await git(dir, "commit", "-m", message);
    const branch = await git(dir, "rev-parse", "--abbrev-ref", "HEAD");
    // Pick up anything pushed meanwhile, then push.
    await git(dir, "pull", "--rebase", "origin", branch);
    const ahead = await git(dir, "rev-list", "--count", `origin/${branch}..HEAD`);
    if (ahead === "0") return `Nothing new to push to ${repo}.`;
    await git(dir, "push", "origin", `HEAD:${branch}`);
    const sha = (await git(dir, "rev-parse", "HEAD")).slice(0, 8);
    return `Pushed ${ahead} commit(s) to ${repo} ${branch} (${sha}): https://github.com/${repo}/commit/${sha}`;
  } catch (e) {
    throw new Error(`Couldn't push ${repo}: ${scrub((e as Error).message)}`);
  }
}
