import { NextResponse } from "next/server";
import { K, newId } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { redis } from "@/lib/redis";

/** Ask the home daemon to answer; the page then polls /api/ping/:id. */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const id = newId("g");
  const r = redis();
  await r.rpush(K.pingQueue, id);
  // Unanswered pings shouldn't pile up while the PC is off.
  await r.ltrim(K.pingQueue, -20, -1);
  await r.expire(K.pingQueue, 600);
  return NextResponse.json({ id, sentAt: Date.now() });
}
