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

/** Handles queued "new project" requests from the dashboard. Returns how many it processed. */
export async function processProjectRequests(relay: Relay): Promise<number> {
  let n = 0;
  for (;;) {
    const id = await relay.r.lpop(K.projectQueue);
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

/** Creates a private GitHub repo with gh, clones it next to wdash, and adds it to projects.json. */
async function createProject(relay: Relay, req: ProjectRequest): Promise<string> {
  const { name, description, testCommand, buildCommand } = req.input;
  const file = env().WDASH_PROJECTS_FILE;
  const current = loadLocalProjects();
  if (current.some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new Error(`A project named ${name} already exists.`);
  const localPath = join(projectsRoot(), name);
  if (existsSync(localPath)) throw new Error(`${localPath} already exists on the PC.`);

  const owner = await gh("api", "user", "-q", ".login");
  const repo = `${owner}/${name}`;
  const exists = await gh("repo", "view", repo, "--json", "name").then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`GitHub repo ${repo} already exists.`);

  console.log(`[project ${name}] creating ${repo}`);
  await gh("repo", "create", repo, "--private", "--add-readme", "--clone", ...(description ? ["--description", description] : []));
  if (!existsSync(join(localPath, ".git"))) throw new Error(`gh created ${repo} but didn't clone it to ${localPath}.`);
  const baseBranch = (await git(localPath, "symbolic-ref", "--short", "HEAD").catch(() => "main")) || "main";

  const commands: ProjectConfig["commands"] = {};
  if (testCommand?.trim()) commands.test = testCommand.trim();
  if (buildCommand?.trim()) commands.build = buildCommand.trim();
  const entry = ProjectConfig.parse({
    name,
    repo,
    baseBranch,
    localPath,
    commands,
    defaultBudgetUsd: 2,
    // Cloud runs need the repo added to the dispatch token, the caller workflow, and Actions secrets.
    cloud: false,
  });
  const raw = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as unknown[]) : [];
  writeFileSync(file, `${JSON.stringify([...raw, entry], null, 2)}\n`);
  await relay.publishProjects(loadLocalProjects());
  console.log(`[project ${name}] ready at ${localPath}`);
  return name;
}
