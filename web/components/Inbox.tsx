"use client";

import { NON_BLOCKING } from "@wdash/shared";
import { ApproveAll, AttentionCard } from "./bits";
import { useBoard } from "./Shell";

export function Inbox() {
  const { state, refresh } = useBoard();
  if (!state) return <p className="text-muted">Loading…</p>;
  const blocking = state.attention.filter((a) => !NON_BLOCKING.includes(a.reason));
  const fyi = state.attention.filter((a) => NON_BLOCKING.includes(a.reason));
  const title = (id: string) => state.jobs.find((j) => j.id === id)?.title ?? id;
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">Waiting on you</h1>
          <span className="ml-auto">
            <ApproveAll items={blocking} onDone={refresh} />
          </span>
        </div>
        {blocking.length === 0 && <p className="text-sm text-muted">Nothing is blocked on you.</p>}
        {blocking.map((a) => (
          <AttentionCard key={a.id} att={a} onDone={refresh} showJob={title(a.jobId)} />
        ))}
      </section>
      {fyi.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-muted">Updates</h2>
          {fyi.map((a) => (
            <AttentionCard key={a.id} att={a} onDone={refresh} showJob={title(a.jobId)} />
          ))}
        </section>
      )}
    </div>
  );
}
