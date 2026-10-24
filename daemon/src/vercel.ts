import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";

/** Pinned so a CLI release can't change flags under running jobs. */
const CLI = "vercel@63.1.2";
const TIMEOUT_MS = 15 * 60 * 1000;

export function vercelConfigured(): boolean {
  return !!process.env.VERCEL_TOKEN;
}

/** Never let the token reach the model or the timeline. */
function scrub(msg: string): string {
  const token = process.env.VERCEL_TOKEN;
  return (token ? msg.split(token).join("***") : msg).replace(/<claude-code-hint[^>]*>\s*/g, "").trim().slice(-1500);
}

/** Vercel project names: lowercase letters, digits, '.', '_', '-'; up to 100 chars. */
export function vercelProjectName(raw: string): string {
  const name = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 100);
  return name || "wdash-app";
}

function run(args: string[], cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolveP) => {
    const token = process.env.VERCEL_TOKEN!;
    const scope = process.env.VERCEL_SCOPE;
    const full = ["--yes", CLI, ...args, "--token", token, ...(scope ? ["--scope", scope] : [])];
    const child = spawn("npx", full, { cwd, env: { ...process.env, CI: "1" }, shell: process.platform === "win32", windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? 1, out, err });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: 1, out, err: `${err}\n${e.message}` });
    });
  });
}

/**
 * Deploy `dir` to the Vercel project `project` (created if it doesn't exist) and return the deployment URL.
 * `vercel link` writes .vercel/ and adds it to .gitignore, so the link never gets committed.
 */
export async function vercelDeploy(dir: string, project: string, prod: boolean): Promise<string> {
  if (!vercelConfigured()) throw new Error("Vercel isn't set up: add VERCEL_TOKEN to daemon/.env (and the WDASH_VERCEL_TOKEN secret for cloud runs).");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`${dir} isn't a folder.`);
  let link = await run(["link", "--yes", "--project", project], dir);
  if (link.code !== 0) {
    // Usually the project doesn't exist yet.
    const add = await run(["project", "add", project], dir);
    if (add.code !== 0 && !/already exists/i.test(add.out + add.err)) throw new Error(`Couldn't create Vercel project ${project}: ${scrub(add.err || add.out)}`);
    link = await run(["link", "--yes", "--project", project], dir);
    if (link.code !== 0) throw new Error(`Couldn't link to Vercel project ${project}: ${scrub(link.err || link.out)}`);
  }
  const dep = await run(["deploy", "--yes", ...(prod ? ["--prod"] : [])], dir);
  if (dep.code !== 0) throw new Error(`Vercel deploy failed: ${scrub(dep.err || dep.out)}`);
  // The CLI prints the deployment URL on stdout; progress and the alias go to stderr.
  const url = dep.out.match(/https:\/\/[^\s]+/g)?.pop();
  if (!url) throw new Error(`Deployed, but couldn't read the URL: ${scrub(dep.out + dep.err)}`);
  const alias = prod ? (dep.err.match(/Aliased:?\s+(https:\/\/[^\s[]+)/i)?.[1] ?? undefined) : undefined;
  return alias && alias !== url ? `${url} (production: ${alias})` : url;
}
