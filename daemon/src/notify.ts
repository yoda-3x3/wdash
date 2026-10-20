import webpush from "web-push";
import { K, buildAttention, attentionId, type Attention, type AttentionReason } from "@wdash/shared";
import { env } from "./config.js";
import type { Relay } from "./relay.js";

// SPEC.md §11.1 — every actionable stop becomes an Attention (inbox + event) and a push notification.

let vapidReady: boolean | undefined;
function vapid(): boolean {
  if (vapidReady === undefined) {
    const e = env();
    vapidReady = !!(e.VAPID_PUBLIC_KEY && e.VAPID_PRIVATE_KEY);
    if (vapidReady) webpush.setVapidDetails(e.VAPID_SUBJECT, e.VAPID_PUBLIC_KEY!, e.VAPID_PRIVATE_KEY!);
  }
  return vapidReady;
}

export type RaiseCtx = { jobId: string; agentId?: string; agentName?: string; ref?: string; detail?: string };

export async function raise(relay: Relay, reason: AttentionReason, ctx: RaiseCtx): Promise<Attention> {
  const att: Attention = { ...buildAttention(reason, ctx), createdAt: Date.now() };
  await relay.r.hset(K.attention, att.id, JSON.stringify(att));
  await relay.emit({ jobId: ctx.jobId, agentId: ctx.agentId, type: "attention", payload: att as unknown as Record<string, unknown> });
  await push(relay, att);
  return att;
}

export async function clear(relay: Relay, jobId: string, reason: AttentionReason, ref?: string): Promise<void> {
  const id = attentionId(jobId, reason, ref);
  const removed = await relay.r.hdel(K.attention, id);
  if (removed) await relay.emit({ jobId, type: "attention_cleared", payload: { id } });
}

/** Clear every open attention for a job (e.g. on cancel). */
export async function clearJob(relay: Relay, jobId: string, except: AttentionReason[] = []): Promise<void> {
  const all = await relay.r.hgetall(K.attention);
  for (const [id, v] of Object.entries(all)) {
    const a = JSON.parse(v) as Attention;
    if (a.jobId === jobId && !except.includes(a.reason)) {
      await relay.r.hdel(K.attention, id);
      await relay.emit({ jobId, type: "attention_cleared", payload: { id } });
    }
  }
}

async function push(relay: Relay, att: Attention): Promise<void> {
  if (!vapid()) return;
  // At most one push per (job, reason) per 2 minutes; the inbox always has the latest.
  const dd = await relay.r.set(K.pushDedupe(att.jobId, att.reason), "1", "EX", 120, "NX");
  if (!dd) return;
  const subs = await relay.r.hgetall(K.pushSubs);
  const payload = JSON.stringify({
    title: att.title,
    body: att.body.slice(0, 300),
    url: `${env().WDASH_WEB_URL}/jobs/${att.jobId}`,
    tag: `${att.jobId}:${att.reason}`,
  });
  await Promise.all(
    Object.entries(subs).map(async ([endpoint, json]) => {
      try {
        await webpush.sendNotification(JSON.parse(json), payload, { TTL: 3600, urgency: "high" });
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await relay.r.hdel(K.pushSubs, endpoint);
      }
    }),
  );
}
