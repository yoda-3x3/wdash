import { gzipSync, gunzipSync } from "node:zlib";

const API = "https://api.github.com";

function headers(): HeadersInit {
  const token = process.env.GITHUB_DISPATCH_TOKEN;
  if (!token) throw new Error("GITHUB_DISPATCH_TOKEN is not set");
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

async function gh(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, { ...init, headers: { ...headers(), ...(init.headers ?? {}) }, cache: "no-store" });
}

/** Start the project's wdash.yml caller workflow for one job (SPEC.md §3). */
export async function dispatchCloudRun(repo: string, ref: string, jobId: string): Promise<void> {
  const res = await gh(`/repos/${repo}/actions/workflows/wdash.yml/dispatches`, {
    method: "POST",
    body: JSON.stringify({ ref, inputs: { job_id: jobId } }),
  });
  if (res.status !== 204) {
    const body = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

export async function deleteBranch(repo: string, branch: string): Promise<void> {
  await gh(`/repos/${repo}/git/refs/heads/${branch}`, { method: "DELETE" });
}

export async function listBranches(repo: string, prefix: string): Promise<string[]> {
  const res = await gh(`/repos/${repo}/git/matching-refs/heads/${prefix}`);
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
