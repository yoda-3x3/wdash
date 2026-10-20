import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { listAttention } from "@/lib/attention";
import { reconcile } from "@/lib/placement";
import { getRateLimits, homeOnline, isPaused, listJobs } from "@/lib/relay";

export const dynamic = "force-dynamic";

/** Board snapshot: jobs, PC status, inbox, usage limits. Also nudges reconcile (throttled). */
export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  await reconcile().catch((e) => console.error("reconcile", e));
  const [jobs, home, attention, paused, rateLimits] = await Promise.all([listJobs(), homeOnline(), listAttention(), isPaused(), getRateLimits()]);
  return NextResponse.json({ jobs, home, attention, paused, rateLimits, now: Date.now() });
}
