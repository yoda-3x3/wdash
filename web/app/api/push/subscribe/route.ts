import { NextResponse } from "next/server";
import { K, PushSubscriptionJson } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { redis } from "@/lib/redis";

export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const sub = PushSubscriptionJson.safeParse(await req.json());
  if (!sub.success) return NextResponse.json({ error: "invalid subscription" }, { status: 400 });
  await redis().hset(K.pushSubs, { [sub.data.endpoint]: JSON.stringify(sub.data) });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { endpoint } = (await req.json()) as { endpoint?: string };
  if (endpoint) await redis().hdel(K.pushSubs, endpoint);
  return NextResponse.json({ ok: true });
}
