import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DAEMON_ROOT, env, loadLocalProjects } from "./config.js";
import { git, tryGit } from "./git.js";
import type { Relay } from "./relay.js";

const WDASH_ROOT = resolve(DAEMON_ROOT, "..");

function gh(args: string[], input?: string): { ok: boolean; out: string; err: string } {
  const r = spawnSync("gh", args, { input, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? r.error?.message ?? "").trim() };
}

/**
 * Lets a project run in the cloud (GitHub Actions): sets the Actions secrets the runner needs, adds the
 * caller workflow on the base branch, and marks it cloud: true. Secret values come from this PC's
 * daemon/.env and the setup state file and are piped to gh, never printed.
 * The GitHub token that starts runs (GITHUB_DISPATCH_TOKEN on Vercel) must also cover the repo.
 */
export async function enableCloud(name: string, relay?: Relay): Promise<string[]> {
  const log: string[] = [];
  const project = loadLocalProjects().find((p) => p.name === name);
  if (!project?.localPath) throw new Error(`No project ${name} with a localPath in projects.json.`);
  const repo = project.repo;

  // 1. Secrets.
  const e = env();
  const setupFile = join(WDASH_ROOT, ".wdash-setup.json");
  const setup = existsSync(setupFile) ? (JSON.parse(readFileSync(setupFile, "utf8")) as Record<string, string>) : {};
  const secrets: Record<string, string | undefined> = {
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? setup.CLAUDE_CODE_OAUTH_TOKEN,
    WDASH_REDIS_URL: e.WDASH_REDIS_URL,
    WDASH_VAPID_PUBLIC_KEY: e.VAPID_PUBLIC_KEY,
    WDASH_VAPID_PRIVATE_KEY: e.VAPID_PRIVATE_KEY,
    WDASH_WEB_URL: e.WDASH_WEB_URL,
    // The wdash repo is private, so the runner needs a token to check it out.
    WDASH_REPO_TOKEN: setup.GITHUB_DISPATCH_TOKEN,
  };
  for (const [k, v] of Object.entries(secrets)) {
    if (!v) {
      log.push(`skipped secret ${k} (no value on this PC)`);
      continue;
    }
    const r = gh(["secret", "set", k, "-R", repo], v);
    if (!r.ok) throw new Error(`Couldn't set ${k} on ${repo}: ${r.err.slice(0, 300)}`);
  }
  log.push(`set Actions secrets on ${repo}`);

  // 2. Caller workflow. Another owner can't call wdash's private reusable workflow, so it gets the standalone one.
  const wdashRepo = ((await tryGit(WDASH_ROOT, "remote", "get-url", "origin")) ?? "").match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/)?.[1];
  if (!wdashRepo) throw new Error("Couldn't tell which GitHub repo wdash is (git remote origin).");
  const sameOwner = repo.split("/")[0]!.toLowerCase() === wdashRepo.split("/")[0]!.toLowerCase();
  // The templates say OWNER/wdash; fill in this wdash repo.
  const template = readFileSync(join(WDASH_ROOT, "templates", sameOwner ? "project-wdash.yml" : "project-wdash-standalone.yml"), "utf8").replaceAll(
    "OWNER/wdash",
    wdashRepo,
  );
  if (template.includes("OWNER/")) throw new Error("The workflow template still has an OWNER placeholder.");
  const rel = ".github/workflows/wdash.yml";
  const target = join(project.localPath, rel);
  const current = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  if (current !== template) {
    const branch = await git(project.localPath, "rev-parse", "--abbrev-ref", "HEAD");
    if (branch !== project.baseBranch) throw new Error(`${project.localPath} is on '${branch}', not '${project.baseBranch}'; switch back and retry.`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, template);
    await git(project.localPath, "add", "--", rel);
    // Commit only the workflow file, whatever else is going on in the checkout.
    await git(project.localPath, "commit", "-m", "Add wdash cloud workflow", "--", rel);
    log.push(`committed ${rel}`);
  }
  await git(project.localPath, "push", "origin", `refs/heads/${project.baseBranch}:refs/heads/${project.baseBranch}`);
  log.push(`pushed ${project.baseBranch} to ${repo}`);

  // 3. Mark it cloud-capable.
  const file = e.WDASH_PROJECTS_FILE;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Array<Record<string, unknown>>;
  for (const p of raw) if (p.name === name) p.cloud = true;
  writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
  if (relay) await relay.publishProjects(loadLocalProjects());
  log.push(`${name}: cloud enabled`);
  return log;
}
