"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Attention, AttentionAction, JobRecord } from "@wdash/shared";
import { NON_BLOCKING } from "@wdash/shared";
import { api, timeAgo } from "@/lib/client";

const STATUS_STYLE: Record<string, string> = {
  queued: "bg-panel-2 text-muted",
  planning: "bg-info/15 text-info",
  running: "bg-info/15 text-info",
  reviewing: "bg-info/15 text-info",
  merging: "bg-info/15 text-info",
  awaiting_plan_approval: "bg-warn/15 text-warn",
  waiting_on_user: "bg-warn/15 text-warn",
  paused: "bg-warn/15 text-warn",
  over_budget: "bg-bad/15 text-bad",
  failed: "bg-bad/15 text-bad",
  done: "bg-ok/15 text-ok",
  cancelled: "bg-panel-2 text-muted",
};

const STATUS_LABEL: Record<string, string> = {
  awaiting_plan_approval: "plan needs approval",
  waiting_on_user: "waiting on you",
  over_budget: "over budget",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`chip ${STATUS_STYLE[status] ?? "bg-panel-2 text-muted"}`}>{STATUS_LABEL[status] ?? status.replaceAll("_", " ")}</span>;
}

export function LocationBadge({ job }: { job: Pick<JobRecord, "location"> }) {
  const map: Record<string, string> = { home: "PC", cloud: "Cloud", migrating: "Moving to cloud", queued: "Queued" };
  return <span className="chip border border-line text-muted">{map[job.location] ?? job.location}</span>;
}

export function Bar({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "warn" | "bad" | "ok" }) {
  const pct = Math.max(0, Math.min(100, max > 0 ? (value / max) * 100 : 0));
  const color = pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : tone === "ok" ? "bg-ok" : "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2">
      <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** One actionable stop (SPEC.md §11.1) with its buttons inline. */
/** Allows every pending permission request in `items` once (the same as pressing each card's Allow). */
export function ApproveAll({ items, onDone }: { items: Attention[]; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const perms = items.filter((a) => a.reason === "permission" && a.ref);
  if (perms.length < 1) return null;
  return (
    <span className="inline-flex items-center gap-2">
      <button
        className="btn btn-primary"
        disabled={busy}
        onClick={async () => {
          if (!confirm(`Allow all ${perms.length} pending permission request${perms.length === 1 ? "" : "s"}?`)) return;
          setBusy(true);
          setErr(undefined);
          const failed: string[] = [];
          for (const a of perms) {
            try {
              await api(`/api/jobs/${a.jobId}/cmd`, { cmd: { type: "decide", requestId: a.ref, allow: true, scope: "once" } });
            } catch (e) {
              failed.push((e as Error).message);
            }
          }
          if (failed.length) setErr(`${failed.length} failed: ${failed[0]}`);
          setBusy(false);
          onDone?.();
        }}
      >
        {busy ? "Approving…" : `Approve all (${perms.length})`}
      </button>
      {err && <span className="text-xs text-bad">{err}</span>}
    </span>
  );
}

export function AttentionCard({ att, onDone, showJob }: { att: Attention; onDone?: () => void; showJob?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string>();
  const [textFor, setTextFor] = useState<AttentionAction>();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string>();

  async function run(a: AttentionAction, value?: string) {
    if (a.href) return router.push(a.href);
    if (a.needsText && value === undefined) {
      setTextFor(a);
      return;
    }
    setBusy(a.label);
    setErr(undefined);
    try {
      if (a.webAction) {
        await api(`/api/jobs/${att.jobId}/cmd`, { webAction: a.webAction });
      } else if (a.cmd) {
        let cmd: Record<string, unknown> = { ...a.cmd };
        if (cmd.type === "raise_budget") cmd = { ...cmd, budgetUsd: Number(value) };
        else if (cmd.type === "user_message") cmd = { ...cmd, text: value };
        else if (cmd.type === "guidance") cmd = { ...cmd, text: value };
        await api(`/api/jobs/${att.jobId}/cmd`, { cmd });
      }
      setTextFor(undefined);
      setText("");
      onDone?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const blocking = !NON_BLOCKING.includes(att.reason);
  return (
    <div className={`card p-3 ${blocking ? "border-warn/50" : ""}`}>
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${blocking ? "bg-warn" : "bg-info"}`} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium">{att.title}</span>
            {showJob && (
              <a href={`/jobs/${att.jobId}`} className="truncate text-xs text-muted hover:underline">
                {showJob}
              </a>
            )}
            <span className="text-xs text-muted">{timeAgo(att.createdAt)}</span>
          </div>
          {att.body && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted">{att.body}</p>}
          {textFor ? (
            <form
              className="mt-2 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (text.trim()) void run(textFor, text.trim());
              }}
            >
              <input
                autoFocus
                className="input"
                inputMode={textFor.cmd?.type === "raise_budget" ? "decimal" : "text"}
                placeholder={textFor.cmd?.type === "raise_budget" ? "New budget in $ (e.g. 10)" : "Type your message"}
                value={text}
                onChange={(e) => setText(e.target.value)}
              />
              <button className="btn btn-primary" disabled={!!busy}>
                Send
              </button>
              <button type="button" className="btn" onClick={() => setTextFor(undefined)}>
                ×
              </button>
            </form>
          ) : (
            <div className="mt-2 flex flex-wrap gap-2">
              {att.actions.map((a) => (
                <button
                  key={a.label}
                  className={`btn ${a.style === "primary" ? "btn-primary" : a.style === "danger" ? "btn-danger" : ""}`}
                  disabled={!!busy}
                  onClick={() => void run(a)}
                >
                  {busy === a.label ? "…" : a.label}
                </button>
              ))}
            </div>
          )}
          {err && <p className="mt-1 text-xs text-bad">{err}</p>}
        </div>
      </div>
    </div>
  );
}
