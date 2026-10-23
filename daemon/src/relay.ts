import { Redis } from "ioredis";
import {
  K,
  TTL_SECONDS,
  HEARTBEAT_TTL_SECONDS,
  LEASE_TTL_SECONDS,
  jobKeys,
  JobRecord,
  AgentRecord,
  Approval,
  Attachment,
  Command,
  ProjectConfig,
  NO_PROJECT,
  scratchProject,
  type WdEvent,
  type JobStatus,
} from "@wdash/shared";
import { env } from "./config.js";

/** Thin typed wrapper over the Upstash Redis relay (TCP via ioredis). */
export class Relay {
  readonly r: Redis;
  /** Separate connection for blocking reads so they don't stall other calls. */
  private readonly blocking: Redis;

  constructor(url = env().WDASH_REDIS_URL) {
    const opts = { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false } as const;
    this.r = quiet(new Redis(url, opts));
    this.blocking = quiet(new Redis(url, opts));
  }

  async close(): Promise<void> {
    this.blocking.disconnect();
    await this.r.quit();
  }

  // ----- jobs -----

  async getJob(id: string): Promise<JobRecord | undefined> {
    const h = await this.r.hgetall(K.job(id));
    if (!h || !h.id) return undefined;
    return JobRecord.parse(h);
  }

  async updateJob(id: string, patch: Partial<Record<keyof JobRecord, string | number | boolean | undefined>>): Promise<void> {
    const flat: Record<string, string> = { updatedAt: String(Date.now()) };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) flat[k] = String(v);
    await this.r.hset(K.job(id), flat);
    await this.r.zadd(K.jobs, Date.now(), id);
    await this.touch(id);
  }

  async setStatus(id: string, status: JobStatus, extra: Record<string, string | number | undefined> = {}): Promise<void> {
    await this.updateJob(id, { status, ...extra });
    await this.emit({ jobId: id, type: "status", payload: { status, ...extra } });
  }

  /** Refresh the 90-day TTL on every key of a job. */
  async touch(id: string): Promise<void> {
    const p = this.r.pipeline();
    for (const k of jobKeys(id)) p.expire(k, TTL_SECONDS);
    await p.exec();
  }

  // ----- events -----

  async emit(e: Omit<WdEvent, "ts" | "id"> & { ts?: number }): Promise<string> {
    const ev = { ts: Date.now(), ...e };
    const id = await this.r.xadd(K.events(e.jobId), "MAXLEN", "~", "20000", "*", "e", JSON.stringify(ev));
    return id ?? "";
  }

  // ----- commands -----

  /** Blocks up to `blockMs` for new commands after `lastId`. */
  async readCommands(jobId: string, lastId: string, blockMs = 5000, conn: Redis = this.blocking): Promise<Array<{ id: string; cmd: Command }>> {
    const res = (await conn.xread("BLOCK", blockMs, "STREAMS", K.cmd(jobId), lastId)) as
      | Array<[string, Array<[string, string[]]>]>
      | null;
    if (!res) return [];
    const out: Array<{ id: string; cmd: Command }> = [];
    for (const [, entries] of res) {
      for (const [id, fields] of entries) {
        const raw = fields[fields.indexOf("c") + 1];
        const parsed = Command.safeParse(safeJson(raw));
        if (parsed.success) out.push({ id, cmd: parsed.data });
        else out.push({ id, cmd: undefined as never });
      }
    }
    return out.filter((c) => c.cmd);
  }

  /** Each job reader needs its own connection: blocking calls serialize per connection. */
  newBlockingConnection(): Redis {
    return quiet(this.r.duplicate());
  }

  async latestCommandId(jobId: string): Promise<string> {
    const last = (await this.r.xrevrange(K.cmd(jobId), "+", "-", "COUNT", 1)) as Array<[string, string[]]>;
    return last[0]?.[0] ?? "0-0";
  }

  // ----- agents -----

  async putAgent(jobId: string, a: AgentRecord): Promise<void> {
    await this.r.hset(K.agents(jobId), a.id, JSON.stringify(a));
  }

  async getAgents(jobId: string): Promise<AgentRecord[]> {
    const h = await this.r.hgetall(K.agents(jobId));
    return Object.values(h).map((v) => AgentRecord.parse(JSON.parse(v)));
  }

  // ----- claims -----

  async getClaims(jobId: string): Promise<Record<string, string>> {
    return this.r.hgetall(K.claims(jobId));
  }

  async setClaims(jobId: string, agentId: string, globs: string[]): Promise<void> {
    if (!globs.length) return;
    const flat: Record<string, string> = {};
    for (const g of globs) flat[g] = agentId;
    await this.r.hset(K.claims(jobId), flat);
  }

  // ----- approvals -----

  async putApproval(a: Approval): Promise<void> {
    await this.r.hset(K.approvals(a.jobId), a.requestId, JSON.stringify(a));
  }

  async getApproval(jobId: string, requestId: string): Promise<Approval | undefined> {
    const v = await this.r.hget(K.approvals(jobId), requestId);
    return v ? Approval.parse(JSON.parse(v)) : undefined;
  }

  async addAllowRule(jobId: string, rule: string): Promise<void> {
    await this.r.sadd(K.allowRules(jobId), rule);
  }

  async getAllowRules(jobId: string): Promise<string[]> {
    return this.r.smembers(K.allowRules(jobId));
  }

  // ----- heartbeats / leases -----

  async heartbeatHome(): Promise<void> {
    await this.r.set(K.homeHeartbeat, String(Date.now()), "EX", HEARTBEAT_TTL_SECONDS);
  }

  async heartbeatCloud(jobId: string): Promise<void> {
    await this.r.set(K.cloudHeartbeat(jobId), String(Date.now()), "EX", HEARTBEAT_TTL_SECONDS);
  }

  /** Take or renew the job lease. Returns false if someone else holds it. */
  async acquireLease(jobId: string, holder: string): Promise<boolean> {
    const ok = await this.r.set(K.lease(jobId), holder, "EX", LEASE_TTL_SECONDS, "NX");
    if (ok) return true;
    const cur = await this.r.get(K.lease(jobId));
    if (cur === holder) {
      await this.r.expire(K.lease(jobId), LEASE_TTL_SECONDS);
      return true;
    }
    return false;
  }

  async releaseLease(jobId: string, holder: string): Promise<void> {
    const cur = await this.r.get(K.lease(jobId));
    if (cur === holder) await this.r.del(K.lease(jobId));
  }

  // ----- misc -----

  async publishProjects(projects: ProjectConfig[]): Promise<void> {
    // No wipe first: projects the website created (not cloned here yet) must stay listed.
    const p = this.r.pipeline();
    for (const pr of projects) {
      // localPath stays on the PC.
      const { localPath: _omit, ...pub } = pr;
      p.hset(K.projects, pr.name, JSON.stringify(pub));
    }
    await p.exec();
  }

  async listFiles(jobId: string): Promise<Attachment[]> {
    const h = await this.r.hgetall(K.files(jobId));
    return Object.values(h)
      .map((v) => Attachment.safeParse(JSON.parse(v)))
      .filter((p) => p.success)
      .map((p) => p.data);
  }

  async putFile(jobId: string, meta: Attachment, data: Buffer): Promise<void> {
    const p = this.r.pipeline();
    p.hset(K.fileData(jobId), meta.id, data.toString("base64"));
    p.hset(K.files(jobId), meta.id, JSON.stringify(meta));
    p.expire(K.fileData(jobId), TTL_SECONDS);
    p.expire(K.files(jobId), TTL_SECONDS);
    await p.exec();
  }

  async getFileData(jobId: string, fileId: string): Promise<Buffer | undefined> {
    const v = await this.r.hget(K.fileData(jobId), fileId);
    return v ? Buffer.from(v, "base64") : undefined;
  }

  async getProject(name: string): Promise<ProjectConfig | undefined> {
    if (name === NO_PROJECT) return scratchProject();
    const v = await this.r.hget(K.projects, name);
    return v ? ProjectConfig.parse(JSON.parse(v)) : undefined;
  }

  async isPaused(): Promise<boolean> {
    return (await this.r.get(K.paused)) === "1";
  }

  /** Blocking pop of the next job for the home daemon. */
  async popHomeJob(timeoutSec = 5): Promise<string | undefined> {
    const res = await this.blocking.brpop(K.homeQueue, timeoutSec);
    return res?.[1];
  }
}

/** ioredis reconnects by itself; log connection errors once instead of crashing with "Unhandled error event". */
function quiet(c: Redis): Redis {
  let last = "";
  c.on("error", (e: Error) => {
    if (e.message !== last) console.warn(`relay connection: ${e.message} (reconnecting)`);
    last = e.message;
  });
  c.on("ready", () => (last = ""));
  return c;
}

function safeJson(s: string | undefined): unknown {
  try {
    return s ? JSON.parse(s) : undefined;
  } catch {
    return undefined;
  }
}
