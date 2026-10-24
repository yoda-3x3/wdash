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
    workers: input.workers,
    budgetUsd: input.budgetUsd ?? project.defaultBudgetUsd,
    // Low usage mode: one review round per worker before asking the user.
    reviewCap: input.lite ? 1 : input.reviewCap,
    autoMode: input.autoMode,
    lite: input.lite,
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
    const { meta, data } = JSON.parse(raw) as { meta: Attachment; data: string };
    out.push(await storeFile(jobId, Attachment.parse(meta), data, taken));
    await redis().del(K.upload(id));
  }
  return out;
}

export async function getFileData(jobId: string, fileId: string): Promise<Buffer | undefined> {
  const v = await redis().hget<string>(K.fileData(jobId), fileId);
  return v ? Buffer.from(v, "base64") : undefined;
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
