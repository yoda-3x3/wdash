import { gzipSync, gunzipSync } from "node:zlib";

const API = "https://api.github.com";

/** Env var holding the token for repos owned by `owner`, e.g. "my-school" -> GITHUB_TOKEN_FOR_MY_SCHOOL. */
export function ownerTokenVar(owner: string): string {
  return `GITHUB_TOKEN_FOR_${owner.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * A fine-grained token can only cover one account's repos, so repos owned by other accounts
 * use their own token; everything else (and the archive) uses GITHUB_DISPATCH_TOKEN.
 */
function tokenFor(repo?: string): string {
  const owner = repo?.split("/")[0];
  const token = (owner && process.env[ownerTokenVar(owner)]) || process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) throw new Error("GITHUB_DISPATCH_TOKEN is not set");
  return token;
}

/** `repo` picks the token; omit it for the wdash repo itself. */
async function gh(path: string, init: RequestInit = {}, repo?: string): Promise<Response> {
  const headers = { Authorization: `Bearer ${tokenFor(repo)}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
  return fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, cache: "no-store" });
}

/** Start the project's wdash.yml caller workflow for one job (SPEC.md §3). */
/**
 * Start wdash-cloud.yml in the wdash repo for one job. It checks out the project repo itself, so projects
 * need no workflow or secrets of their own. `projectRepo` is empty for a chat without a project.
 */
export async function dispatchCloudRun(projectRepo: string, jobId: string): Promise<void> {
  const wdash = archiveRepo();
  const res = await gh(`/repos/${wdash}/actions/workflows/wdash-cloud.yml/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref: "main", inputs: { job_id: jobId, repo: projectRepo } }),
  });
  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

/**
 * Create a private repo for the token's account (needs the token's "Administration: write" permission).
 * Returns undefined when the token isn't allowed to, so the caller can fall back to the PC.
 */
export async function createRepo(name: string, description?: string): Promise<{ repo: string; baseBranch: string } | undefined> {
  const res = await gh(`/user/repos`, { method: "POST", body: JSON.stringify({ name, description, private: true, auto_init: true }) });
  if (res.status === 403 || res.status === 401) return undefined;
  const body = (await res.json().catch(() => ({}))) as { full_name?: string; default_branch?: string; message?: string; errors?: Array<{ message?: string }> };
  if (res.status === 422) throw new Error(body.errors?.[0]?.message ?? `A repo named ${name} already exists on GitHub.`);
  if (!res.ok || !body.full_name) throw new Error(`GitHub couldn't create the repo (${res.status}): ${body.message ?? ""}`);
  return { repo: body.full_name, baseBranch: body.default_branch ?? "main" };
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" }, repo);
}

export async function listBranches(repo: string, prefix: string): Promise<string[]> {
  const res = await gh(`/repos/${repo}/git/matching-refs/heads/${prefix}`, {}, repo);
  if (!res.ok) return [];
  const refs = (await res.json()) as Array<{ ref: string }>;
  return refs.map((r) => r.ref.replace("refs/heads/", ""));
}

const ARCHIVE_BRANCH = "wdash-archive";

function archiveRepo(): string {
  const r = process.env.WDASH_ARCHIVE_REPO;
  if (!r) throw new Error("WDASH_ARCHIVE_REPO is not set");
  return r;
}

async function ensureArchiveBranch(repo: string): Promise<void> {
  const exists = await gh(`/repos/${repo}/git/ref/heads/${ARCHIVE_BRANCH}`);
  if (exists.ok) return;
  const info = (await (await gh(`/repos/${repo}`)).json()) as { default_branch: string };
  const base = (await (await gh(`/repos/${repo}/git/ref/heads/${info.default_branch}`)).json()) as { object: { sha: string } };
  const res = await gh(`/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${ARCHIVE_BRANCH}`, sha: base.object.sha }) });
  if (!res.ok && res.status !== 422) throw new Error(`Couldn't create ${ARCHIVE_BRANCH}: ${res.status}`);
}

/** Store a job archive as gzipped JSON in the wdash repo's wdash-archive branch (SPEC.md §14). */
export async function writeArchive(jobId: string, data: unknown): Promise<void> {
  const repo = archiveRepo();
  await ensureArchiveBranch(repo);
  const path = `archive/${jobId}.json.gz`;
  const content = gzipSync(Buffer.from(JSON.stringify(data))).toString("base64");
  const existing = await gh(`/repos/${repo}/contents/${path}?ref=${ARCHIVE_BRANCH}`);
  const sha = existing.ok ? ((await existing.json()) as { sha: string }).sha : undefined;
  const res = await gh(`/repos/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message: `archive job ${jobId}`, content, branch: ARCHIVE_BRANCH, sha }),
  });
  if (!res.ok) throw new Error(`Archive write failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
}

export async function readArchive(jobId: string): Promise<unknown | undefined> {
  const repo = archiveRepo();
  const res = await gh(`/repos/${repo}/contents/archive/${jobId}.json.gz?ref=${ARCHIVE_BRANCH}`, {
    headers: { Accept: "application/vnd.github.raw" },
  });
  if (!res.ok) return undefined;
  const buf = Buffer.from(await res.arrayBuffer());
  return JSON.parse(gunzipSync(buf).toString("utf8"));
}
