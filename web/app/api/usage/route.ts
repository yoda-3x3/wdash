import { NextResponse } from "next/server";
import { K, UPSTASH_REQUEST_LIMIT, UPSTASH_STORAGE_LIMIT, kaggleHours, upstashStats, type KaggleSession } from "@wdash/shared";
import { requireApiUser } from "@/lib/auth";
import { hgetall, redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 60 * 60_000;

type Server = { slot: number; url: string; key: string; models: string[]; startedAt: number; user?: string; lastSeen?: number; accel?: "gpu" | "tpu" };

/** Kaggle servers and GPU/TPU hours (tracked by wdash), plus Upstash requests and storage. */
export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  const now = Date.now();

  const servers = Object.values(await hgetall(K.kaggleServers)).map((v) => JSON.parse(v) as Server);
  const live = await Promise.all(
    servers.map(async (s) => {
      const res = await fetch(`${s.url}/wdash/health`, { headers: { Authorization: `Bearer ${s.key}` }, signal: AbortSignal.timeout(8000) }).catch(() => undefined);
      return { slot: s.slot, user: s.user ?? "?", models: s.models, accel: s.accel ?? "gpu", startedAt: s.startedAt, healthy: !!res?.ok };
    }),
  );

  const raw = (await redis().zrange<string[]>(K.kaggleSessions, now - WEEK_MS, "+inf", { byScore: true })) ?? [];
  const hours = kaggleHours(
    raw.map((r) => JSON.parse(r) as KaggleSession),
    live,
    now,
    WEEK_MS,
  );

  const log = ((await redis().lrange<string>(K.kaggleLog, 0, 7)) ?? []).map((l) => JSON.parse(l) as { at: number; text: string });

  return NextResponse.json(
    { kaggle: { servers: live, hours, log }, redis: await redisUsage() },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Requests this month and storage come from Upstash's management API when UPSTASH_EMAIL and UPSTASH_API_KEY are set
 * (console.upstash.com/account/api); otherwise only the key count is known.
 */
async function redisUsage() {
  const keys = await redis().dbsize();
  const base = { keys, requestLimit: UPSTASH_REQUEST_LIMIT, storageLimit: UPSTASH_STORAGE_LIMIT };
  const email = process.env.UPSTASH_EMAIL;
  const apiKey = process.env.UPSTASH_API_KEY;
  const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  if (!email || !apiKey || !restUrl) return { ...base, source: "keys" as const };
  try {
    return { ...base, source: "upstash" as const, ...(await upstashStats(email, apiKey, new URL(restUrl).host)) };
  } catch (e) {
    return { ...base, source: "keys" as const, note: `Upstash API: ${(e as Error).message}` };
  }
}
