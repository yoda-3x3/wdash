"use client";

import { useState } from "react";
import { KAGGLE_MODELS, KAGGLE_TPU_MODELS } from "@wdash/shared";
import { api, timeAgo, usePoll } from "@/lib/client";

type UsageData = {
  kaggle: {
    servers: Array<{ slot: number; user: string; models: string[]; accel: "gpu" | "tpu"; startedAt: number; healthy: boolean }>;
    hours: Array<{ user: string; accel: string; hours: number; quota: number }>;
    log: Array<{ at: number; text: string }>;
  };
  redis: { keys: number; requestLimit: number; storageLimit: number; source: "upstash" | "keys"; monthlyRequests?: number; storageBytes?: number; note?: string };
};

const fmtMB = (b: number) => `${(b / 1024 / 1024).toFixed(1)} MB`;

/** Kaggle servers (start/stop), Kaggle GPU/TPU hours, and Upstash requests/storage. Settings page. */
export function Usage() {
  const { data, refresh } = usePoll<UsageData>("/api/usage", 30_000);
  const [model, setModel] = useState(KAGGLE_MODELS[0]!.id);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();

  async function control(body: { action: "start"; model: string } | { action: "stop"; slot: number }) {
    setBusy(true);
    setErr(undefined);
    try {
      await api("/api/kaggle", body);
      setTimeout(refresh, 1500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const k = data?.kaggle;
  const r = data?.redis;
  return (
    <>
      <section className="card space-y-3 p-4">
        <h2 className="font-medium">Kaggle servers</h2>
        <p className="text-xs text-muted">Free open-model servers on Kaggle notebooks (up to 2 at once). Jobs start them by themselves; these buttons are for starting one ahead of time or stopping one early.</p>
        {!k ? (
          <p className="text-sm text-muted">…</p>
        ) : k.servers.length === 0 ? (
          <p className="text-sm text-muted">None running.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {k.servers.map((s) => (
              <li key={s.slot} className="flex flex-wrap items-center gap-2 py-2">
                <span className="font-medium">Server {s.slot}</span>
                <span className="rounded border border-line px-1.5 text-[11px] uppercase text-muted">{s.accel}</span>
                <span className="text-xs text-muted">{s.user}</span>
                <span className="text-xs">{s.models.join(", ")}</span>
                <span className={`text-xs ${s.healthy ? "text-ok" : "text-warn"}`}>{s.healthy ? "up" : "not answering"}</span>
                <span className="text-xs text-muted">started {timeAgo(s.startedAt)}</span>
                <button className="btn ml-auto px-2 py-0.5 text-xs" disabled={busy} onClick={() => control({ action: "stop", slot: s.slot })}>
                  Stop
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <select className="input sm:w-72" value={model} onChange={(e) => setModel(e.target.value)}>
            <optgroup label="GPU (2x T4, Ollama)">
              {KAGGLE_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
            <optgroup label="TPU v5e-8 (vLLM, experimental)">
              {KAGGLE_TPU_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          </select>
          <button className="btn btn-primary" disabled={busy} onClick={() => control({ action: "start", model })}>
            + Start server
          </button>
        </div>
        <p className="text-xs text-muted">Your PC starts it (it has the Kaggle tokens), so the PC must be online. Booting takes ~5–15 min on GPU, longer on TPU.</p>
        {err && <p className="text-xs text-bad">{err}</p>}
        {k && k.log.length > 0 && (
          <ul className="space-y-0.5 text-xs text-muted">
            {k.log.map((l, i) => (
              <li key={i}>
                <span className="mr-2">{timeAgo(l.at)}</span>
                {l.text}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-medium">Usage</h2>
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted">Kaggle hours, last 7 days (tracked by wdash; Kaggle&apos;s own count is in the notebook editor)</h3>
          {!k ? (
            <p className="text-sm text-muted">…</p>
          ) : k.hours.length === 0 ? (
            <p className="text-sm text-muted">No Kaggle servers in the last 7 days.</p>
          ) : (
            k.hours.map((h) => <Meter key={`${h.user}-${h.accel}`} label={`${h.user} · ${h.accel.toUpperCase()}`} value={h.hours} max={h.quota} unit="h" />)
          )}
        </div>
        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted">Upstash Redis (free plan)</h3>
          {!r ? (
            <p className="text-sm text-muted">…</p>
          ) : r.source === "upstash" ? (
            <>
              <Meter label="Requests this month" value={r.monthlyRequests ?? 0} max={r.requestLimit} format={(n) => n.toLocaleString()} />
              <Meter label="Storage" value={r.storageBytes ?? 0} max={r.storageLimit} format={fmtMB} />
              <p className="text-xs text-muted">{r.keys.toLocaleString()} keys</p>
            </>
          ) : (
            <p className="text-xs text-muted">
              {r.keys.toLocaleString()} keys. For requests and storage, add UPSTASH_EMAIL and UPSTASH_API_KEY (a management key from console.upstash.com/account/api) to the website&apos;s Vercel settings.
              {r.note ? ` (${r.note})` : ""}
            </p>
          )}
        </div>
      </section>
    </>
  );
}

function Meter({ label, value, max, unit = "", format }: { label: string; value: number; max: number; unit?: string; format?: (n: number) => string }) {
  const pct = Math.min(100, (value / max) * 100);
  const show = format ?? ((n: number) => `${n}${unit}`);
  return (
    <div className="space-y-1">
      <div className="flex text-xs">
        <span>{label}</span>
        <span className="ml-auto text-muted">
          {show(value)} / {show(max)}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded bg-panel-2">
        <div className={`h-full ${pct > 90 ? "bg-bad" : pct > 70 ? "bg-warn" : "bg-accent"}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
