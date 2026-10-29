import { K, QUOTA_JOB, UPSTASH_REQUEST_LIMIT, UPSTASH_STORAGE_LIMIT, kaggleHours, upstashStats, type KaggleSession } from "@wdash/shared";
import { env } from "./config.js";
import { clear, raise } from "./notify.js";
import type { Relay } from "./relay.js";

/** Warn at these fractions of a quota, once per level per period. */
const LEVELS = [0.8, 0.95];
const WEEK_MS = 7 * 24 * 60 * 60_000;

/** One quota: `family` identifies the inbox card; `period` changes when the quota resets, so warnings repeat then. */
type Reading = { family: string; period: string; label: string; fraction: number; detail: string };

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet",
  seven_day_overage_included: "weekly",
  overage: "extra usage",
};

/** Claude subscription windows, from the rate-limit events agents' sessions report (K.rateLimit). */
async function claude(relay: Relay): Promise<Reading[]> {
  const out: Reading[] = [];
  for (const [type, raw] of Object.entries(await relay.r.hgetall(K.rateLimit))) {
    const info = JSON.parse(raw) as { utilization?: number; resetsAt?: number; status?: string };
    if (typeof info.utilization !== "number") continue;
    // The window rolled over since this was reported; the number no longer applies.
    if (info.resetsAt && info.resetsAt * 1000 < Date.now()) continue;
    const fraction = info.utilization > 1.5 ? info.utilization / 100 : info.utilization;
    const resets = info.resetsAt ? `, resets ${new Date(info.resetsAt * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}` : "";
    const label = `Claude ${CLAUDE_WINDOWS[type] ?? type} limit`;
    out.push({ family: `claude:${type}`, period: String(info.resetsAt ?? "?"), label, fraction, detail: `${label} is at ${Math.round(fraction * 100)}%${resets}.` });
  }
  return out;
}

/** Kaggle GPU/TPU hours per account over the last 7 days (wdash's own count). */
async function kaggle(relay: Relay): Promise<Reading[]> {
  const now = Date.now();
  const sessions = (await relay.r.zrangebyscore(K.kaggleSessions, now - WEEK_MS, "+inf")).map((s) => JSON.parse(s) as KaggleSession);
  const running = Object.values(await relay.r.hgetall(K.kaggleServers)).map((s) => JSON.parse(s) as { user?: string; accel?: "gpu" | "tpu"; startedAt: number });
  // A rolling window has no reset moment; repeat a warning at most once a week.
  const week = String(Math.floor(now / WEEK_MS));
  return kaggleHours(sessions, running, now, WEEK_MS).map((h) => {
    const label = `Kaggle ${h.accel.toUpperCase()} hours (${h.user})`;
    return { family: `kaggle:${h.user}:${h.accel}`, period: week, label, fraction: h.hours / h.quota, detail: `${label}: ${h.hours} of ${h.quota} h used in the last 7 days.` };
  });
}

/** Upstash requests this month and storage, when UPSTASH_EMAIL and UPSTASH_API_KEY are in daemon/.env. */
async function upstash(): Promise<Reading[]> {
  const { UPSTASH_EMAIL: email, UPSTASH_API_KEY: apiKey } = process.env;
  if (!email || !apiKey) return [];
  const host = new URL(env().WDASH_REDIS_URL).hostname;
  const s = await upstashStats(email, apiKey, host);
  const month = new Date().toISOString().slice(0, 7);
  const out: Reading[] = [];
  if (s.monthlyRequests !== undefined) {
    const f = s.monthlyRequests / UPSTASH_REQUEST_LIMIT;
    out.push({ family: "upstash:requests", period: month, label: "Upstash requests", fraction: f, detail: `Upstash requests this month: ${s.monthlyRequests.toLocaleString()} of ${UPSTASH_REQUEST_LIMIT.toLocaleString()} (${Math.round(f * 100)}%). wdash stops working at the limit.` });
  }
  if (s.storageBytes !== undefined) {
    const f = s.storageBytes / UPSTASH_STORAGE_LIMIT;
    out.push({ family: "upstash:storage", period: "storage", label: "Upstash storage", fraction: f, detail: `Upstash storage: ${(s.storageBytes / 1048576).toFixed(0)} of 256 MB (${Math.round(f * 100)}%).` });
  }
  return out;
}

/**
 * Raise a "Usage quota warning" (inbox + phone) when a quota passes 80% and again at 95%, once per level per period;
 * clear the card once it's back under 80% (e.g. the window reset).
 */
export async function checkQuotas(relay: Relay): Promise<void> {
  const readings = (await Promise.all([claude(relay), kaggle(relay), upstash()].map((p) => p.catch((e) => (console.error("quota check", (e as Error).message), [] as Reading[]))))).flat();
  for (const r of readings) {
    const level = [...LEVELS].reverse().find((l) => r.fraction >= l);
    if (!level) {
      await clear(relay, QUOTA_JOB, "quota_warning", r.family);
      continue;
    }
    const first = await relay.r.set(K.quotaSent(`${r.family}:${r.period}:${level}`), "1", "EX", 8 * 24 * 3600, "NX");
    if (first) await raise(relay, "quota_warning", { jobId: QUOTA_JOB, ref: r.family, detail: r.detail });
  }
}
