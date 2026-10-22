"use client";

import type { Attention } from "@wdash/shared";
import { api } from "./client";

/**
 * Allow or deny the next waiting permission request (oldest first, preferring the job you're looking at),
 * once. Used by hands-free controls (gestures, winks). Returns a short line describing what happened.
 */
export async function decideNext(allow: boolean, jobId?: string): Promise<string> {
  const s = await api<{ attention: Attention[] }>("/api/state").catch(() => undefined);
  const perms = (s?.attention ?? []).filter((x) => x.reason === "permission" && x.ref).sort((x, y) => x.createdAt - y.createdAt);
  const target = perms.find((x) => x.jobId === jobId) ?? perms[0];
  if (!target) return allow ? "Nothing waiting for approval" : "Nothing to deny";
  try {
    await api(`/api/jobs/${target.jobId}/cmd`, { cmd: { type: "decide", requestId: target.ref, allow, scope: "once" } });
    return `${allow ? "Allowed" : "Denied"}: ${(target.body ?? target.title).slice(0, 60)}`;
  } catch (e) {
    return `Couldn't ${allow ? "allow" : "deny"}: ${(e as Error).message}`;
  }
}

/** Path → job id, when on a job page. */
export function jobIdFromPath(path: string): string | undefined {
  return path.startsWith("/jobs/") ? path.split("/")[2] : undefined;
}
