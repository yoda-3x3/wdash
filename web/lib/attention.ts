import webpush from "web-push";
import { K, Attention, attentionId, buildAttention, type AttentionReason } from "@wdash/shared";
import { hgetall, redis } from "./redis";
import { emit } from "./relay";

// Web-side twin of daemon/src/notify.ts, for stops only the web can see (PC offline, dispatch failures).

let vapidReady: boolean | undefined;
function vapid(): boolean {
  if (vapidReady === undefined) {
    const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    vapidReady = !!(pub && priv);
    if (vapidReady) webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:wdash@example.com", pub!, priv!);
  }
  return vapidReady;
}

export async function raise(reason: AttentionReason, ctx: { jobId: string; agentId?: string; ref?: string; detail?: string }): Promise<void> {
  const att: Attention = { ...buildAttention(reason, ctx), createdAt: Date.now() };
  const r = redis();
  await r.hset(K.attention, { [att.id]: JSON.stringify(att) });
  await emit(ctx.jobId, "attention", att as unknown as Record<string, unknown>);
  await sendPush(att);
}

export async function clear(jobId: string, reason: AttentionReason, ref?: string): Promise<void> {
  const id = attentionId(jobId, reason, ref);
  const n = await redis().hdel(K.attention, id);
  if (n) await emit(jobId, "attention_cleared", { id });
}

export async function clearAllForJob(jobId: string): Promise<void> {
  const all = (await hgetall(K.attention)) ?? {};
  for (const [id, v] of Object.entries(all)) {
    if ((JSON.parse(v) as Attention).jobId === jobId) {
      await redis().hdel(K.attention, id);
      await emit(jobId, "attention_cleared", { id });
    }
  }
}

export async function listAttention(): Promise<Attention[]> {
  const all = (await hgetall(K.attention)) ?? {};
  return Object.values(all)
    .map((v) => Attention.safeParse(JSON.parse(v)))
    .filter((p) => p.success)
    .map((p) => p.data)
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function sendPush(att: Pick<Attention, "jobId" | "reason" | "title" | "body">): Promise<void> {
  if (!vapid()) return;
  const r = redis();
  const ok = await r.set(K.pushDedupe(att.jobId, att.reason), "1", { ex: 120, nx: true });
  if (!ok) return;
  const subs = (await hgetall(K.pushSubs)) ?? {};
  const payload = JSON.stringify({ title: att.title, body: att.body.slice(0, 300), url: `/jobs/${att.jobId}`, tag: `${att.jobId}:${att.reason}` });
  await Promise.all(
    Object.entries(subs).map(async ([endpoint, json]) => {
      try {
        await webpush.sendNotification(JSON.parse(json), payload, { TTL: 3600, urgency: "high" });
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await r.hdel(K.pushSubs, endpoint);
      }
    }),
  );
}
