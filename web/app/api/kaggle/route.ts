import { NextResponse } from "next/server";
import { K, KaggleControl } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { redis } from "@/lib/redis";

/** Start or stop a Kaggle model server. The home daemon does it (it has the Kaggle tokens) and logs progress to K.kaggleLog. */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = KaggleControl.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  const r = redis();
  await r.rpush(K.kaggleQueue, JSON.stringify(parsed.data));
  // Clicks shouldn't pile up while the PC is off.
  await r.ltrim(K.kaggleQueue, -5, -1);
  await r.expire(K.kaggleQueue, 3600);
  return NextResponse.json({ ok: true });
}
