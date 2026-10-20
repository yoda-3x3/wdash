import { NextResponse } from "next/server";
import { TERMINAL_STATUSES, type WdEvent } from "@wdash/shared";
import { requireApiUser } from "@/lib/auth";
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
  return NextResponse.json({ jobs: out.map(({ job, agents }) => ({ job, agents })), events, cursors: next, now });
}
