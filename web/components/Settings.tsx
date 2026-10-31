"use client";

import Link from "next/link";
import { MoodPicker } from "./MoodPicker";
import { signOut } from "next-auth/react";
import { useEffect, useState } from "react";
import type { ProjectConfig } from "@wdash/shared";
import { api, timeAgo, usePoll } from "@/lib/client";
import { setTechMode, useTechMode } from "@/lib/tech";
import { useBoard } from "./Shell";
import { Usage } from "./Usage";

/** Settings heading with its sub-tabs. */
export function SettingsTabs({ active }: { active: "general" | "cache" }) {
  const tab = (id: typeof active, href: string, label: string) => (
    <Link href={href} className={`rounded-md px-3 py-1 ${active === id ? "bg-panel-2 font-medium" : "text-muted"}`}>
      {label}
    </Link>
  );
  return (
    <div className="flex items-center gap-3">
      <h1 className="text-lg font-semibold">Settings</h1>
      <div className="ml-auto flex rounded-lg border border-line p-0.5 text-sm">
        {tab("general", "/settings", "General")}
        {tab("cache", "/settings/cache", "Worker cache")}
      </div>
    </div>
  );
}

function b64ToUint8(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function Settings({ login, vapidKey }: { login: string; vapidKey: string }) {
  const { state } = useBoard();
  const { data } = usePoll<{ projects: ProjectConfig[] }>("/api/projects", 60_000);
  const [push, setPush] = useState<"unsupported" | "off" | "on" | "denied" | "loading">("loading");
  const [msg, setMsg] = useState<string>();
  const tech = useTechMode();

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return setPush("unsupported");
      if (Notification.permission === "denied") return setPush("denied");
      const reg = await navigator.serviceWorker.ready;
      setPush((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setPush("unsupported"));
  }, []);

  async function enablePush() {
    setMsg(undefined);
    try {
      if (!vapidKey) throw new Error("NEXT_PUBLIC_VAPID_PUBLIC_KEY isn't set on the server.");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") return setPush("denied");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToUint8(vapidKey) });
      await api("/api/push/subscribe", sub.toJSON());
      setPush("on");
      setMsg("Notifications on for this device.");
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  async function disablePush() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await api("/api/push/subscribe", { endpoint: sub.endpoint }, "DELETE");
      await sub.unsubscribe();
    }
    setPush("off");
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <SettingsTabs active="general" />

      <section className="card space-y-3 p-4">
        <h2 className="font-medium">Mood</h2>
        <MoodPicker />
        <p className="text-xs text-muted">Saved on this device.</p>
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="font-medium">Notifications on this device</h2>
        <p className="text-sm text-muted">wdash notifies you whenever an agent stops and you can do something about it: permission prompts, questions, plan approvals, budget, errors, merges, the PC going offline, and finished jobs.</p>
        {push === "unsupported" && (
          <p className="text-sm text-warn">This browser doesn&apos;t support web push. On iPhone, add wdash to your Home Screen first (Share → Add to Home Screen) and open it from there.</p>
        )}
        {push === "denied" && <p className="text-sm text-bad">Notifications are blocked for this site in your browser settings.</p>}
        {push === "off" && (
          <button className="btn btn-primary" onClick={enablePush}>
            Enable notifications
          </button>
        )}
        {push === "on" && (
          <button className="btn" onClick={disablePush}>
            Turn off on this device
          </button>
        )}
        {msg && <p className="text-xs text-muted">{msg}</p>}
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="font-medium">Home PC</h2>
        <p className="text-sm">
          {!state ? <span className="text-muted">…</span> : state.home.online ? <span className="text-ok">Online</span> : <span className="text-muted">Offline</span>}
          {state?.home.lastSeen && <span className="text-muted"> · heartbeat {timeAgo(state.home.lastSeen)}</span>}
        </p>
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="font-medium">Technical mode</h2>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={tech} onChange={(e) => setTechMode(e.target.checked)} />
          <span>
            Show every diagnostic on the Wall
            <span className="block text-xs text-muted">
              Per agent: tokens in/out, cache, turns, tokens/s, last activity, session, branch, review rounds, files owned. Per job: lease holder, location, budget,
              pending approvals. System: PC heartbeat, poll latency, event rate, queue, Kaggle servers, Claude limits, Redis keys. Saved on this device; adds a few Redis
              reads per Wall refresh.
            </span>
          </span>
        </label>
      </section>

      <Usage />

      <section className="card space-y-2 p-4">
        <h2 className="font-medium">Projects</h2>
        <p className="text-xs text-muted">Published by the PC daemon from daemon/config/projects.json. Edit that file to change them.</p>
        <ul className="divide-y divide-line text-sm">
          {(data?.projects ?? []).map((p) => (
            <li key={p.name} className="py-2">
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="text-xs text-muted">{p.repo}</span>
                <span className="ml-auto text-xs text-muted">{p.cloud ? "PC + cloud" : "PC only"}</span>
              </div>
              <div className="mt-0.5 font-mono text-[11px] text-muted">
                {Object.entries(p.commands)
                  .filter(([, v]) => v)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join(" · ") || "no checks configured"}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="card flex items-center justify-between p-4 text-sm">
        <span>
          Signed in as <span className="font-medium">{login}</span>
        </span>
        <button className="btn" onClick={() => signOut({ callbackUrl: "/signin" })}>
          Sign out
        </button>
      </section>
    </div>
  );
}
