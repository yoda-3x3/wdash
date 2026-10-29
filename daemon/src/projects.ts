import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { K, ProjectConfig, ProjectRequest } from "@wdash/shared";
import { DAEMON_ROOT, env, loadLocalProjects } from "./config.js";
import { git } from "./git.js";
import type { Relay } from "./relay.js";

const run = promisify(execFile);
const REQUEST_TTL_SECONDS = 24 * 60 * 60;

/** New project repos are cloned next to the wdash checkout (e.g. C:\Users\you\Dance\<name>). */
export function projectsRoot(): string {
  return process.env.WDASH_NEW_PROJECTS_DIR || resolve(DAEMON_ROOT, "..", "..");
}

async function gh(...args: string[]): Promise<string> {
  try {
    const { stdout } = await run("gh", args, { cwd: projectsRoot(), windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string; code?: string };
    if (err.code === "ENOENT") throw new Error("The GitHub CLI (gh) isn't installed on the PC.");
    throw new Error((err.stderr || err.message).trim().slice(0, 500));
  }
}

async function save(relay: Relay, req: ProjectRequest): Promise<void> {
  req.updatedAt = Date.now();
  await relay.r.set(K.projectRequest(req.id), JSON.stringify(req), "EX", REQUEST_TTL_SECONDS);
}

/** Handles queued "new project" requests from the dashboard, starting with `first` if it was already popped. Returns how many it processed. */
export async function processProjectRequests(relay: Relay, first?: string): Promise<number> {
  let n = 0;
  for (let next = first; ; next = undefined) {
    const id = next ?? (await relay.r.lpop(K.projectQueue));
    if (!id) return n;
    n++;
    const raw = await relay.r.get(K.projectRequest(id));
    if (!raw) continue;
    const req = ProjectRequest.parse(JSON.parse(raw));
    if (req.status !== "pending") continue;
    req.status = "creating";
    await save(relay, req);
    try {
      req.project = await createProject(relay, req);
      req.status = "done";
    } catch (e) {
      req.status = "failed";
      req.error = (e as Error).message;
      console.error(`[project ${req.input.name}] ${req.error}`);
    }
    await save(relay, req);
  }
}

/**
 * New project: create a private GitHub repo with gh (unless the website already created it, in which case
 * req.repo is set), clone it next to wdash, and add it to projects.json. Cloud runs need nothing per project:
 * wdash-cloud.yml in the wdash repo checks the project out.
 */
async function createProject(relay: Relay, req: ProjectRequest): Promise<string> {
  const { name, description, testCommand, buildCommand, autoDeploy } = req.input;
  const file = env().WDASH_PROJECTS_FILE;
  if (loadLocalProjects().some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    if (req.repo) return name; // already adopted
    throw new Error(`A project named ${name} already exists.`);
  }
  const localPath = join(projectsRoot(), name);

  let repo = req.repo;
  if (repo) {
    // The website created it: just clone it here.
    if (!existsSync(join(localPath, ".git"))) {
      if (existsSync(localPath)) throw new Error(`${localPath} already exists on the PC.`);
      console.log(`[project ${name}] cloning ${repo}`);
      await gh("repo", "clone", repo, localPath);
    }
  } else {
    if (existsSync(localPath)) throw new Error(`${localPath} already exists on the PC.`);
    const owner = await gh("api", "user", "-q", ".login");
    repo = `${owner}/${name}`;
    const exists = await gh("repo", "view", repo, "--json", "name").then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`GitHub repo ${repo} already exists.`);
    console.log(`[project ${name}] creating ${repo}`);
    await gh("repo", "create", repo, "--private", "--add-readme", "--clone", ...(description ? ["--description", description] : []));
  }
  if (!existsSync(join(localPath, ".git"))) throw new Error(`${repo} isn't cloned at ${localPath}.`);
  const baseBranch = (await git(localPath, "symbolic-ref", "--short", "HEAD").catch(() => "main")) || "main";

  const commands: ProjectConfig["commands"] = {};
  if (testCommand?.trim()) commands.test = testCommand.trim();
  if (buildCommand?.trim()) commands.build = buildCommand.trim();
  const entry = ProjectConfig.parse({ name, repo, baseBranch, localPath, commands, defaultBudgetUsd: 2, cloud: true, autoDeploy });
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown[]) : [];
  writeFileSync(file, `${JSON.stringify([...raw, entry], null, 2)}\n`);
  await relay.publishProjects(loadLocalProjects());
  console.log(`[project ${name}] ready at ${localPath}`);
  return name;
}
