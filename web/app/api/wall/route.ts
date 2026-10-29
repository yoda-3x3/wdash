import { NextResponse } from "next/server";
import { K, TERMINAL_STATUSES, type WdEvent } from "@wdash/shared";
import { requireApiUser } from "@/lib/auth";
import { hgetall, redis } from "@/lib/redis";
import { getAgents, getEvents, getRecentEvents, listJobs } from "@/lib/relay";

export const dynamic = "force-dynamic";

const BACKFILL = 150;
const RECENT_DONE_MS = 15 * 60_000;

/**
 * Feed for the wall view: every live job (plus ones that finished in the last 15 min), its agents,
 * and new events per job. `c` is a JSON map of jobId -> last seen stream id.
 */
export async function GET(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  let cursors: Record<string, string> = {};
  try {
    cursors = JSON.parse(new URL(req.url).searchParams.get("c") ?? "{}");
  } catch {
    /* start fresh */
  }
  const now = Date.now();
  const jobs = (await listJobs(80)).filter(
    (j) => !j.archived && (!TERMINAL_STATUSES.includes(j.status) || now - j.updatedAt < RECENT_DONE_MS),
  );
  const out = await Promise.all(
    jobs.map(async (job) => {
      const cur = cursors[job.id];
      const valid = typeof cur === "string" && /^\d+-\d+$/.test(cur);
      const [agents, events] = await Promise.all([
        getAgents(job.id),
        valid ? getEvents(job.id, cur, 300) : getRecentEvents(job.id, BACKFILL),
      ]);
      return { job, agents, events, cursor: events.at(-1)?.id ?? (valid ? cur : undefined) };
    }),
  );
  const next: Record<string, string> = {};
  const events: Record<string, WdEvent[]> = {};
  for (const o of out) {
    if (o.cursor) next[o.job.id] = o.cursor;
    events[o.job.id] = o.events;
  }
  const tech = new URL(req.url).searchParams.get("t") === "1" ? await diagnostics(jobs.map((j) => j.id)) : undefined;
  return NextResponse.json({ jobs: out.map(({ job, agents }) => ({ job, agents })), events, cursors: next, now, tech });
}

/** Technical mode (Settings): per-agent usage and leases for each job, plus system state. Costs a few extra Redis reads per poll. */
async function diagnostics(jobIds: string[]) {
  const r = redis();
  const perJob = await Promise.all(
    jobIds.map(async (id) => {
      const [usage, lease, leaseTtl, pending] = await Promise.all([hgetall(K.usage(id)), r.get<string>(K.lease(id)), r.ttl(K.lease(id)), hgetall(K.approvals(id))]);
      const agentUsage = Object.fromEntries(Object.entries(usage).map(([a, v]) => [a, JSON.parse(v) as Record<string, number | string>]));
      const waiting = Object.values(pending).filter((v) => (JSON.parse(v) as { status?: string }).status === "pending").length;
      return [id, { usage: agentUsage, lease, leaseTtl, pendingApprovals: waiting }] as const;
    }),
  );
  const [heartbeat, heartbeatTtl, kaggle, limits, homeQueue, attention, keys] = await Promise.all([
    r.get<string>(K.homeHeartbeat),
    r.ttl(K.homeHeartbeat),
    hgetall(K.kaggleServers),
    hgetall(K.rateLimit),
    r.llen(K.homeQueue),
    r.hlen(K.attention),
    r.dbsize(),
  ]);
  return {
    jobs: Object.fromEntries(perJob),
    sys: {
      heartbeatAt: heartbeat ? Number(heartbeat) : undefined,
      heartbeatTtl,
      homeQueue,
      attention,
      redisKeys: keys,
      kaggle: Object.values(kaggle).map((v) => {
        const s = JSON.parse(v) as { slot: number; models: string[]; accel?: string; user?: string; startedAt: number; lastSeen?: number };
        return { slot: s.slot, models: s.models, accel: s.accel ?? "gpu", user: s.user, startedAt: s.startedAt, lastSeen: s.lastSeen };
      }),
      limits: Object.entries(limits).map(([type, v]) => {
        const l = JSON.parse(v) as { utilization?: number; resetsAt?: number; status?: string; updatedAt?: number };
        return { type, utilization: l.utilization, resetsAt: l.resetsAt, status: l.status, updatedAt: l.updatedAt };
      }),
    },
  };
}
