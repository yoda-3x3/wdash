import { NextResponse } from "next/server";
import { K, KAGGLE_GPU_HOURS_PER_WEEK, KAGGLE_TPU_HOURS_PER_WEEK, type KaggleSession } from "@wdash/shared";
import { requireApiUser } from "@/lib/auth";
import { hgetall, redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Upstash free plan. */
const REDIS_REQUEST_LIMIT = 500_000;
const REDIS_STORAGE_LIMIT = 256 * 1024 * 1024;

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

  // Hours in the last 7 days per account and accelerator: finished sessions (clipped to the window) plus running servers.
  const raw = (await redis().zrange<string[]>(K.kaggleSessions, now - WEEK_MS, "+inf", { byScore: true })) ?? [];
  const hours = new Map<string, number>();
  const add = (user: string, accel: string, start: number, end: number) => {
    const k = `${user}|${accel}`;
    hours.set(k, (hours.get(k) ?? 0) + Math.max(0, end - Math.max(start, now - WEEK_MS)) / 3_600_000);
  };
  for (const r of raw) {
    const s = JSON.parse(r) as KaggleSession & { accel?: string };
    add(s.user, s.accel ?? "gpu", s.start, s.end);
  }
  for (const s of live) add(s.user, s.accel, s.startedAt, now);
  const kaggleHours = [...hours].map(([k, h]) => {
    const [user, accel] = k.split("|") as [string, string];
    return { user, accel, hours: Math.round(h * 10) / 10, quota: accel === "tpu" ? KAGGLE_TPU_HOURS_PER_WEEK : KAGGLE_GPU_HOURS_PER_WEEK };
  });

  const log = ((await redis().lrange<string>(K.kaggleLog, 0, 7)) ?? []).map((l) => JSON.parse(l) as { at: number; text: string });

  return NextResponse.json(
    { kaggle: { servers: live, hours: kaggleHours, log }, redis: await redisUsage() },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * Requests this month and storage come from Upstash's management API when UPSTASH_EMAIL and UPSTASH_API_KEY are set
 * (console.upstash.com/account/api); otherwise only the key count is known.
 */
async function redisUsage() {
  const keys = await redis().dbsize();
  const base = { keys, requestLimit: REDIS_REQUEST_LIMIT, storageLimit: REDIS_STORAGE_LIMIT };
  const email = process.env.UPSTASH_EMAIL;
  const apiKey = process.env.UPSTASH_API_KEY;
  const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
  if (!email || !apiKey || !restUrl) return { ...base, source: "keys" as const };
  try {
    const auth = { Authorization: `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}` };
    const host = new URL(restUrl).host;
    const dbs = (await (await fetch("https://api.upstash.com/v2/redis/databases", { headers: auth })).json()) as Array<{ database_id: string; endpoint: string }>;
    const db = dbs.find((d) => d.endpoint === host);
    if (!db) return { ...base, source: "keys" as const, note: `No database ${host} on that Upstash account` };
    const stats = (await (await fetch(`https://api.upstash.com/v2/redis/stats/${db.database_id}`, { headers: auth })).json()) as {
      total_monthly_requests?: number;
      current_storage?: number;
    };
    return { ...base, source: "upstash" as const, monthlyRequests: stats.total_monthly_requests, storageBytes: stats.current_storage };
  } catch (e) {
    return { ...base, source: "keys" as const, note: `Upstash API: ${(e as Error).message}` };
  }
}
