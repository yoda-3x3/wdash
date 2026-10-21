"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export async function api<T = unknown>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  if (res.status === 401) {
    window.location.href = "/signin";
    throw new Error("signed out");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

/** Poll a JSON endpoint; pauses while the tab is hidden (saves Upstash commands, SPEC.md §13). */
export function usePoll<T>(path: string | null, intervalMs: number): { data: T | undefined; error: string | undefined; refresh: () => void } {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const tick = useRef(0);

  const load = useCallback(async () => {
    if (!path) return;
    const my = ++tick.current;
    try {
      const d = await api<T>(path);
      if (my === tick.current) {
        setData(d);
        setError(undefined);
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, [path]);

  useEffect(() => {
    if (!path) return;
    void load();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, intervalMs);
    const onVis = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [path, intervalMs, load]);

  return { data, error, refresh: load };
}

export function timeAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return "—";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** 950, 12.3k, 4.1M */
export function tokens(n: number | undefined): string {
  const v = n ?? 0;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(Math.round(v));
}

/** Tooltip text for a job's token counts. */
export function tokenTitle(job: { tokensIn?: number; tokensOut?: number }): string {
  return `${(job.tokensIn ?? 0).toLocaleString()} input tokens (incl. cache) · ${(job.tokensOut ?? 0).toLocaleString()} output tokens`;
}

export function usd(n: number | undefined): string {
  return `$${(n ?? 0).toFixed(2)}`;
}
