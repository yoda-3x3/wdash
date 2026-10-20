import { NextResponse } from "next/server";
import { K, TERMINAL_STATUSES } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { redis } from "@/lib/redis";
import { listJobs, pushCommand } from "@/lib/relay";

/** Global kill switch (SPEC.md §9): pause every live job and stop the PC from picking up new ones. */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { paused } = (await req.json()) as { paused: boolean };
  if (paused) await redis().set(K.paused, "1");
  else await redis().del(K.paused);
  const live = (await listJobs(100)).filter((j) => !TERMINAL_STATUSES.includes(j.status) && j.status !== "queued");
  await Promise.all(live.map((j) => pushCommand(j.id, { type: paused ? "pause" : "resume" })));
  return NextResponse.json({ ok: true, affected: live.length });
}
