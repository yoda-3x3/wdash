import { NextResponse } from "next/server";
import { CacheEntry, CacheEntryInput, K } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { hgetall, redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

/** Worker cache: shared notes every agent sees (Settings > Worker cache). */
export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  const entries = Object.values(await hgetall(K.workerCache))
    .map((v) => CacheEntry.safeParse(JSON.parse(v)))
    .flatMap((p) => (p.success ? [p.data] : []))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return NextResponse.json({ entries }, { headers: { "cache-control": "no-store" } });
}

/** Add or replace an entry. */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = CacheEntryInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  const entry: CacheEntry = { ...parsed.data, updatedAt: Date.now(), by: "you" };
  await redis().hset(K.workerCache, { [entry.id]: JSON.stringify(entry) });
  return NextResponse.json({ entry });
}

export async function DELETE(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await redis().hdel(K.workerCache, id);
  return NextResponse.json({ ok: true });
}
