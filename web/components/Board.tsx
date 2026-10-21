"use client";

import Link from "next/link";
import { useState } from "react";
import { TERMINAL_STATUSES, type JobRecord } from "@wdash/shared";
import { api, timeAgo, usd } from "@/lib/client";
import { ApproveAll, AttentionCard, Bar, LocationBadge, StatusChip } from "./bits";
import { useBoard } from "./Shell";

export function Board() {
  const { state, refresh } = useBoard();
  const [showArchived, setShowArchived] = useState(false);
  if (!state) return <p className="text-muted">Loading…</p>;

  const waitingByJob = new Map<string, number>();
  for (const a of state.attention) waitingByJob.set(a.jobId, (waitingByJob.get(a.jobId) ?? 0) + 1);
  const jobs = state.jobs.filter((j) => showArchived || !j.archived);
  const active = jobs.filter((j) => !TERMINAL_STATUSES.includes(j.status));
  const finished = jobs.filter((j) => TERMINAL_STATUSES.includes(j.status));
  const top = state.attention.slice(0, 3);

  return (
    <div className="space-y-6">
      <TopBar paused={state.paused} onChange={refresh} rateLimits={state.rateLimits} />

      {top.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted">Needs you</h2>
            <span className="flex items-center gap-3">
              {state.attention.filter((a) => a.reason === "permission").length > 1 && <ApproveAll items={state.attention} onDone={refresh} />}
              {state.attention.length > 3 && (
                <Link href="/inbox" className="text-xs text-accent">
                  All {state.attention.length} →
                </Link>
              )}
            </span>
          </div>
          {top.map((a) => (
            <AttentionCard key={a.id} att={a} onDone={refresh} showJob={state.jobs.find((j) => j.id === a.jobId)?.title} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted">Active</h2>
        {active.length === 0 ? (
          <div className="card p-6 text-center text-sm text-muted">
            Nothing running. <Link href="/new" className="text-accent">Start a job</Link>
          </div>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {active.map((j) => (
              <JobCard key={j.id} job={j} waiting={waitingByJob.get(j.id) ?? 0} now={state.now} />
            ))}
          </div>
        )}
      </section>

      {finished.length > 0 && (
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted">Finished</h2>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> show archived
            </label>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {finished.map((j) => (
              <JobCard key={j.id} job={j} waiting={waitingByJob.get(j.id) ?? 0} now={state.now} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function JobCard({ job, waiting, now }: { job: JobRecord; waiting: number; now: number }) {
  return (
    <Link href={`/jobs/${job.id}`} className={`card block p-3 transition hover:border-accent/60 ${waiting ? "border-warn/50" : ""}`}>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="font-medium text-fg">{job.project}</span>
        {job.kind === "chat" && <span className="chip bg-info/15 text-info">chat</span>}
        <span>·</span>
        <span>{timeAgo(job.updatedAt, now)}</span>
        <span className="ml-auto flex gap-1">
          <LocationBadge job={job} />
          <StatusChip status={job.status} />
        </span>
      </div>
      <p className="mt-1.5 line-clamp-2 text-sm">{job.title}</p>
      <div className="mt-2 flex items-center gap-2 text-xs text-muted">
        <div className="flex-1">
          <Bar value={job.costUsd} max={job.budgetUsd} />
        </div>
        <span>
          {usd(job.costUsd)} / {usd(job.budgetUsd)}
        </span>
        {waiting > 0 && <span className="chip bg-warn/15 text-warn">{waiting} waiting</span>}
        {job.mergeState === "needs_merge" && <span className="chip bg-bad/15 text-bad">needs merge</span>}
        {job.archived && <span className="chip bg-panel-2">archived</span>}
      </div>
    </Link>
  );
}

function TopBar({ paused, onChange, rateLimits }: { paused: boolean; onChange: () => void; rateLimits: { rateLimitType?: string; utilization?: number; status: string }[] }) {
  const [busy, setBusy] = useState(false);
  const shown = rateLimits.filter((r) => typeof r.utilization === "number");
  return (
    <div className="card flex flex-wrap items-center gap-3 p-3">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-xs font-semibold text-muted">Claude usage</div>
        {shown.length === 0 ? (
          <div className="text-xs text-muted">No usage reported yet. It appears after the first agent turn.</div>
        ) : (
          shown.map((r) => (
            <div key={r.rateLimitType} className="flex items-center gap-2 text-xs">
              <span className="w-28 shrink-0 text-muted">{(r.rateLimitType ?? "limit").replaceAll("_", " ")}</span>
              <Bar value={pct(r.utilization)} max={100} />
              <span className="w-10 text-right">{Math.round(pct(r.utilization))}%</span>
            </div>
          ))
        )}
      </div>
      <button
        className={`btn ${paused ? "btn-primary" : "btn-danger"}`}
        disabled={busy}
        onClick={async () => {
          if (!paused && !confirm("Pause every running job?")) return;
          setBusy(true);
          try {
            await api("/api/pause", { paused: !paused });
            onChange();
          } finally {
            setBusy(false);
          }
        }}
      >
        {paused ? "Resume all" : "Pause all"}
      </button>
    </div>
  );
}

/** The SDK reports utilization as a 0-1 fraction; tolerate 0-100 too. */
function pct(u: number | undefined): number {
  const v = u ?? 0;
  return v <= 1 ? v * 100 : v;
}
