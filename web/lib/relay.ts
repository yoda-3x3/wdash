import {
  K,
  TTL_SECONDS,
  jobKeys,
  newId,
  AgentRecord,
  Approval,
  JobRecord,
  ProjectConfig,
  ProjectRequest,
  NO_PROJECT,
  scratchProject,
  type NewProjectInput,
  RateLimitInfo,
  WdEvent,
  Attachment,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_SHARE_BYTES,
  UPLOAD_CHUNK_BYTES,
  FILE_CHUNK_TTL_SECONDS,
  safeFileName,
  uniqueFileName,
  type Command,
  type EventType,
  type NewJobInput,
} from "@wdash/shared";
import { hgetall, redis, xrange, xrevrange } from "./redis";

// Data access for the web app. Mirrors daemon/src/relay.ts over Upstash REST.

export async function emit(jobId: string, type: EventType, payload: Record<string, unknown>): Promise<void> {
  const ev = { ts: Date.now(), jobId, type, payload };
  await redis().xadd(K.events(jobId), "*", { e: JSON.stringify(ev) }, { trim: { type: "MAXLEN", threshold: 20000, comparison: "~" } });
}

export async function getJob(id: string): Promise<JobRecord | undefined> {
  const h = await hgetall(K.job(id));
  if (!h || !h.id) return undefined;
  const p = JobRecord.safeParse(h);
  return p.success ? p.data : undefined;
}

export async function updateJob(id: string, patch: Record<string, string | number | boolean | undefined>): Promise<void> {
  const flat: Record<string, string> = { updatedAt: String(Date.now()) };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) flat[k] = String(v);
  const r = redis();
  await r.hset(K.job(id), flat);
  await r.zadd(K.jobs, { score: Date.now(), member: id });
}

export async function setStatus(id: string, status: JobRecord["status"], extra: Record<string, string> = {}): Promise<void> {
  await updateJob(id, { status, ...extra });
  await emit(id, "status", { status, ...extra });
}

export async function listJobs(limit = 60): Promise<JobRecord[]> {
  const ids = await redis().zrange<string[]>(K.jobs, 0, limit - 1, { rev: true });
  const jobs = await Promise.all(ids.map((id) => getJob(id)));
  return jobs.filter((j): j is JobRecord => !!j);
}

export async function getProjects(): Promise<ProjectConfig[]> {
  const h = (await hgetall(K.projects)) ?? {};
  return Object.values(h)
    .map((v) => ProjectConfig.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getProject(name: string): Promise<ProjectConfig | undefined> {
  if (name === NO_PROJECT) return scratchProject();
  const v = await redis().hget<string>(K.projects, name);
  return v ? ProjectConfig.parse(JSON.parse(v)) : undefined;
}

export async function homeOnline(): Promise<{ online: boolean; lastSeen?: number }> {
  const v = await redis().get<string>(K.homeHeartbeat);
  return { online: !!v, lastSeen: v ? Number(v) : undefined };
}

export async function createJob(input: NewJobInput, project: ProjectConfig): Promise<JobRecord> {
  const id = newId("j");
  const now = Date.now();
  const title = input.task.split("\n")[0]!.slice(0, 80);
  const job: JobRecord = JobRecord.parse({
    id,
    project: project.name,
    task: input.task,
    title,
    status: "queued",
    location: "queued",
    kind: input.kind,
    chatModel: input.chatModel,
    runOn: input.runOn,
    models: input.models,
    kaggleModel: input.kaggleModel,
    kaggleWorkerModel: input.kaggleWorkerModel,
    workers: input.workers,
    budgetUsd: input.budgetUsd ?? project.defaultBudgetUsd,
    // Low usage mode: one review round per worker before asking the user.
    reviewCap: input.lite ? 1 : input.reviewCap,
    autoMode: input.autoMode,
    lite: input.lite,
    shape: input.shape,
    costUsd: 0,
    createdAt: now,
    updatedAt: now,
    mergeState: "none",
    archived: false,
  });
  const flat: Record<string, string> = {};
  for (const [k, v] of Object.entries(job)) if (v !== undefined) flat[k] = String(v);
  const r = redis();
  await r.hset(K.job(id), flat);
  await r.expire(K.job(id), TTL_SECONDS);
  await r.zadd(K.jobs, { score: now, member: id });
  await emit(id, "info", { text: `Job created for ${project.name}` });
  return job;
}

export async function pushCommand(jobId: string, cmd: Command): Promise<void> {
  await redis().xadd(K.cmd(jobId), "*", { c: JSON.stringify(cmd) }, { trim: { type: "MAXLEN", threshold: 2000, comparison: "~" } });
  await redis().expire(K.cmd(jobId), TTL_SECONDS);
}

/** Events strictly after `after` (a stream id), oldest first. */
export async function getEvents(jobId: string, after = "-", count = 400): Promise<WdEvent[]> {
  const start = after === "-" ? "-" : `(${after}`;
  const out: WdEvent[] = [];
  for (const [id, fields] of await xrange(K.events(jobId), start, "+", count)) {
    const e = parseEvent(id, fields);
    if (e) out.push(e);
  }
  return out;
}

function parseEvent(id: string, fields: Record<string, string>): WdEvent | undefined {
  try {
    const p = WdEvent.safeParse({ ...JSON.parse(fields.e!), id });
    return p.success ? p.data : undefined;
  } catch {
    return undefined;
  }
}

/** The newest `count` events, oldest first (initial backfill for the wall). */
export async function getRecentEvents(jobId: string, count: number): Promise<WdEvent[]> {
  const rows = await xrevrange(K.events(jobId), "+", "-", count);
  return rows
    .map(([id, f]) => parseEvent(id, f))
    .filter((e): e is WdEvent => !!e)
    .reverse();
}

export async function getAgents(jobId: string): Promise<AgentRecord[]> {
  return Object.values(await hgetall(K.agents(jobId)))
    .map((v) => AgentRecord.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data);
}

export async function getJobDetail(id: string) {
  const r = redis();
  const [job, agentsH, approvalsH, claims, usageH, lease, files] = await Promise.all([
    getJob(id),
    hgetall(K.agents(id)),
    hgetall(K.approvals(id)),
    hgetall(K.claims(id)),
    hgetall(K.usage(id)),
    r.get<string>(K.lease(id)),
    listFiles(id),
  ]);
  const agents = Object.values(agentsH ?? {})
    .map((v) => AgentRecord.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data);
  const approvals = Object.values(approvalsH ?? {})
    .map((v) => Approval.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data)
    .filter((a) => a.status === "pending");
  const usage = Object.fromEntries(Object.entries(usageH ?? {}).map(([k, v]) => [k, JSON.parse(v) as Record<string, number | string>]));
  return { job, agents, approvals, claims: claims ?? {}, usage, lease, files };
}

export async function getRateLimits(): Promise<RateLimitInfo[]> {
  const h = (await hgetall(K.rateLimit)) ?? {};
  return Object.values(h)
    .map((v) => RateLimitInfo.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data);
}

export async function isPaused(): Promise<boolean> {
  return (await redis().get<string>(K.paused)) === "1";
}

export async function deleteJobData(id: string): Promise<void> {
  const keys = jobKeys(id).filter((k) => k !== K.job(id));
  await redis().del(...keys);
}

// ---------------------------------------------------------------- attachments

const UPLOAD_TTL_SECONDS = 24 * 60 * 60;

/** Holds a file picked on the New job form until the job is created (or for a day). */
export async function stageUpload(rawName: string, type: string, bytes: Uint8Array): Promise<Attachment> {
  const meta: Attachment = { id: newId("f"), name: safeFileName(rawName), size: bytes.byteLength, type: type || "application/octet-stream", addedAt: Date.now() };
  await redis().set(K.upload(meta.id), JSON.stringify({ meta, data: Buffer.from(bytes).toString("base64") }), { ex: UPLOAD_TTL_SECONDS });
  return meta;
}

export async function listFiles(jobId: string): Promise<Attachment[]> {
  const h = await hgetall(K.files(jobId));
  return Object.values(h)
    .map((v) => Attachment.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data)
    .sort((a, b) => a.addedAt - b.addedAt);
}

async function storeFile(jobId: string, meta: Attachment, base64: string, taken: Set<string>): Promise<Attachment> {
  const m = { ...meta, name: uniqueFileName(meta.name, taken) };
  taken.add(m.name);
  const r = redis();
  await r.hset(K.fileData(jobId), { [m.id]: base64 });
  await r.hset(K.files(jobId), { [m.id]: JSON.stringify(m) });
  await r.expire(K.fileData(jobId), TTL_SECONDS);
  await r.expire(K.files(jobId), TTL_SECONDS);
  return m;
}

/** Adds a file to an existing job. The daemon picks it up when a message references it. */
export async function addJobFile(jobId: string, rawName: string, type: string, bytes: Uint8Array): Promise<Attachment> {
  const existing = await listFiles(jobId);
  if (existing.length >= MAX_ATTACHMENTS) throw new Error(`A job can have at most ${MAX_ATTACHMENTS} files.`);
  const meta: Attachment = { id: newId("f"), name: safeFileName(rawName), size: bytes.byteLength, type: type || "application/octet-stream", addedAt: Date.now() };
  return storeFile(jobId, meta, Buffer.from(bytes).toString("base64"), new Set(existing.map((f) => f.name)));
}

/** Moves staged uploads into a new job. Unknown or expired ids are an error so the user isn't surprised later. */
export async function attachUploads(jobId: string, uploadIds: string[]): Promise<Attachment[]> {
  const taken = new Set<string>();
  const out: Attachment[] = [];
  for (const id of uploadIds) {
    const raw = await redis().get<string>(K.upload(id));
    if (!raw) throw new Error("An attached file expired or failed to upload. Remove it and attach it again.");
    const staged = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as StagedUpload;
    if (staged.chunked) out.push(await storeChunkedFile(jobId, { ...staged, meta: Attachment.parse(staged.meta) }, taken));
    else out.push(await storeFile(jobId, Attachment.parse(staged.meta), staged.data ?? "", taken));
    await redis().del(K.upload(id));
  }
  return out;
}

export async function getFileData(jobId: string, fileId: string): Promise<Buffer | undefined> {
  const meta = (await listFiles(jobId)).find((f) => f.id === fileId);
  if (meta?.chunks) {
    // Downloads go out in one response, which Vercel caps; big uploads are for the agents, not for downloading back.
    if (meta.size > MAX_SHARE_BYTES) return undefined;
    const parts = await redis().mget<(string | null)[]>(...Array.from({ length: meta.chunks }, (_, n) => K.fileChunk(fileId, n)));
    if (parts.some((p) => p === null)) return undefined;
    return Buffer.concat(parts.map((p) => Buffer.from(p as string, "base64")));
  }
  const v = await redis().hget<string>(K.fileData(jobId), fileId);
  return v ? Buffer.from(v, "base64") : undefined;
}

// ---------------------------------------------------------------- chunked uploads (files up to MAX_ATTACHMENT_BYTES)

type StagedUpload = { meta: Attachment; data?: string; chunked?: boolean; complete?: boolean };

/** Bytes piece `n` must have: UPLOAD_CHUNK_BYTES, except the last, which has the rest. */
export function chunkSize(size: number, chunks: number, n: number): number {
  return n < chunks - 1 ? UPLOAD_CHUNK_BYTES : size - UPLOAD_CHUNK_BYTES * (chunks - 1);
}

/** Starts an upload: the browser then PUTs each piece and calls completeUpload. */
export async function startUpload(rawName: string, type: string, size: number): Promise<Attachment> {
  if (!Number.isInteger(size) || size <= 0) throw new Error("The file is empty.");
  if (size > MAX_ATTACHMENT_BYTES) throw new Error(`Files can be at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  const chunks = Math.max(1, Math.ceil(size / UPLOAD_CHUNK_BYTES));
  const meta: Attachment = { id: newId("f"), name: safeFileName(rawName), size, type: type || "application/octet-stream", addedAt: Date.now(), chunks };
  const staged: StagedUpload = { meta, chunked: true };
  await redis().set(K.upload(meta.id), JSON.stringify(staged), { ex: UPLOAD_TTL_SECONDS });
  return meta;
}

async function getStaged(id: string): Promise<StagedUpload | undefined> {
  const raw = await redis().get<string>(K.upload(id));
  return raw ? (JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw)) as StagedUpload) : undefined;
}

/** Stores piece `n` of an upload. Each piece is one request, under Vercel's body limit. */
export async function putUploadChunk(id: string, n: number, bytes: Uint8Array): Promise<void> {
  const staged = await getStaged(id);
  if (!staged?.chunked || !staged.meta.chunks) throw new Error("Unknown or expired upload. Attach the file again.");
  const { chunks, size } = { chunks: staged.meta.chunks, size: staged.meta.size };
  if (!Number.isInteger(n) || n < 0 || n >= chunks) throw new Error("Bad piece number.");
  if (bytes.byteLength !== chunkSize(size, chunks, n)) throw new Error(`Piece ${n} has the wrong size.`);
  await redis().set(K.fileChunk(id, n), Buffer.from(bytes).toString("base64"), { ex: UPLOAD_TTL_SECONDS });
}

/** Checks every piece arrived. Returns the file's metadata for the form. */
export async function completeUpload(id: string): Promise<Attachment> {
  const staged = await getStaged(id);
  if (!staged?.chunked || !staged.meta.chunks) throw new Error("Unknown or expired upload. Attach the file again.");
  const keys = Array.from({ length: staged.meta.chunks }, (_, n) => K.fileChunk(id, n));
  const have = await redis().exists(...keys);
  if (have !== keys.length) throw new Error(`Only ${have} of ${keys.length} pieces arrived. Attach the file again.`);
  staged.complete = true;
  await redis().set(K.upload(id), JSON.stringify(staged), { ex: UPLOAD_TTL_SECONDS });
  return staged.meta;
}

/** Moves a finished chunked upload onto a job: only the metadata moves; the pieces stay, kept longer. */
async function storeChunkedFile(jobId: string, staged: StagedUpload, taken: Set<string>): Promise<Attachment> {
  if (!staged.complete || !staged.meta.chunks) throw new Error(`${staged.meta.name} didn't finish uploading. Remove it and attach it again.`);
  const m: Attachment = { ...staged.meta, name: uniqueFileName(staged.meta.name, taken) };
  taken.add(m.name);
  const r = redis();
  await r.hset(K.files(jobId), { [m.id]: JSON.stringify(m) });
  await r.expire(K.files(jobId), TTL_SECONDS);
  for (let n = 0; n < m.chunks!; n++) await r.expire(K.fileChunk(m.id, n), FILE_CHUNK_TTL_SECONDS);
  return m;
}

/** Adds an already-uploaded file (chunked) to a running job. */
export async function addJobUpload(jobId: string, uploadId: string): Promise<Attachment> {
  const existing = await listFiles(jobId);
  if (existing.length >= MAX_ATTACHMENTS) throw new Error(`A job can have at most ${MAX_ATTACHMENTS} files.`);
  const staged = await getStaged(uploadId);
  if (!staged) throw new Error("The file expired or failed to upload. Attach it again.");
  const m = await storeChunkedFile(jobId, staged, new Set(existing.map((f) => f.name)));
  await redis().del(K.upload(uploadId));
  return m;
}

// ---------------------------------------------------------------- new projects

/** Queues a "create project" request for the home daemon, which does the GitHub side with gh. */
/** `repo` set: the website already created it on GitHub; the PC only clones and registers it. */
export async function createProjectRequest(input: NewProjectInput, repo?: string): Promise<ProjectRequest> {
  const now = Date.now();
  const req: ProjectRequest = { id: newId("p"), input, status: "pending", createdAt: now, updatedAt: now, ...(repo ? { repo } : {}) };
  const r = redis();
  await r.set(K.projectRequest(req.id), JSON.stringify(req), { ex: 24 * 60 * 60 });
  await r.rpush(K.projectQueue, req.id);
  return req;
}

export async function getProjectRequest(id: string): Promise<ProjectRequest | undefined> {
  const v = await redis().get<string>(K.projectRequest(id));
  if (!v) return undefined;
  const p = ProjectRequest.safeParse(JSON.parse(v));
  return p.success ? p.data : undefined;
}
