"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord, Approval, Attachment, Attention, JobRecord, WdEvent } from "@wdash/shared";
import { CHAT_AGENT, NO_PROJECT, TERMINAL_STATUSES, projectLabel } from "@wdash/shared";
import { api, timeAgo, tokenTitle, tokens, usd, usePoll } from "@/lib/client";
import { ApproveAll, AttentionCard, Bar, LocationBadge, StatusChip } from "./bits";
import { AttachButton, FileChips, dropProps, fmtSize, useUploads } from "./Attachments";
import { Conference } from "./Conference";

type Detail = {
  job: JobRecord;
  agents: AgentRecord[];
  approvals: Approval[];
  claims: Record<string, string>;
  usage: Record<string, Record<string, number | string>>;
  lease: string | null;
  attention: Attention[];
  files?: Attachment[];
};

const TABS = ["timeline", "team", "diff", "usage"] as const;
type Tab = (typeof TABS)[number];

export function JobView({ id }: { id: string }) {
  const [call, setCall] = useState(false);
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.includes(params.get("tab") as Tab) ? params.get("tab") : "timeline") as Tab;
  const { data: detail, refresh, error } = usePoll<Detail>(`/api/jobs/${id}`, 2500);
  const archived = detail?.job.archived;
  const live = useEvents(archived ? null : id);
  const [archiveData, setArchiveData] = useState<{ events: WdEvent[]; agents: AgentRecord[] }>();

  useEffect(() => {
    if (archived && !archiveData) void api<{ events: WdEvent[]; agents: AgentRecord[] }>(`/api/jobs/${id}/archive`).then(setArchiveData).catch(() => undefined);
  }, [archived, archiveData, id]);

  const events = archived ? (archiveData?.events ?? []) : live;
  const agents = archived ? (archiveData?.agents ?? detail?.agents ?? []) : (detail?.agents ?? []);

  if (error === "not found") return <p className="text-muted">Job not found (it may have expired after 90 days).</p>;
  if (!detail) return <p className="text-muted">Loading…</p>;
  const { job } = detail;
  const setTab = (t: Tab) => router.replace(`/jobs/${id}?tab=${t}`, { scroll: false });

  return (
    <div className="space-y-4">
      <Header job={job} lease={detail.lease} onChange={refresh} onCall={archived ? undefined : () => setCall(true)} />
      {call && <Conference jobId={id} agents={agents} events={events} onClose={() => setCall(false)} />}
      <JobFiles jobId={id} files={detail.files ?? []} />

      {detail.attention.some((a) => a.reason !== "question") && (
        <div className="space-y-2">
          {detail.attention.filter((a) => a.reason === "permission").length > 1 && (
            <div className="flex justify-end">
              <ApproveAll items={detail.attention} onDone={refresh} />
            </div>
          )}
          {detail.attention
            .filter((a) => a.reason !== "question")
            .map((a) => (
              <AttentionCard key={a.id} att={a} onDone={refresh} />
            ))}
        </div>
      )}

      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm capitalize ${tab === t ? "border-accent font-medium" : "border-transparent text-muted"}`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "timeline" && <Timeline events={events} agents={agents} />}
      {tab === "team" && <Team job={job} agents={agents} events={events} claims={detail.claims} onChange={refresh} />}
      {tab === "diff" && <Diffs events={events} job={job} />}
      {tab === "usage" && <Usage job={job} agents={agents} usage={detail.usage} />}

      {detail.approvals
        .filter((a) => a.kind === "question")
        .map((q) => (
          <QuestionCard key={q.requestId} jobId={id} q={q} onDone={refresh} />
        ))}
      {!TERMINAL_STATUSES.includes(job.status) && !archived && <Working agents={agents} events={events} />}
      {(!TERMINAL_STATUSES.includes(job.status) || job.status === "done") && !archived && (
        <ChatBox
          reopen={job.status === "done"}
          jobId={id}
          agents={agents}
          lead={job.kind === "chat" ? CHAT_AGENT : "orchestrator"}
          asking={detail.approvals.filter((a) => a.kind === "question").map((a) => a.agentId)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- events

function useEvents(id: string | null): WdEvent[] {
  const [events, setEvents] = useState<WdEvent[]>([]);
  const cursor = useRef("-");
  useEffect(() => {
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    cursor.current = "-";
    setEvents([]);
    const loop = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") {
        try {
          for (;;) {
            const res = await api<{ events: WdEvent[]; cursor: string }>(`/api/jobs/${id}/events?after=${encodeURIComponent(cursor.current)}`);
            if (stop) return;
            cursor.current = res.cursor;
            if (res.events.length) setEvents((prev) => [...prev, ...res.events]);
            if (res.events.length < 400) break;
          }
        } catch {
          /* retry next tick */
        }
      }
      timer = setTimeout(loop, 1500);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);
  return events;
}

// ---------------------------------------------------------------- header

function Header({ job, lease, onChange, onCall }: { job: JobRecord; lease: string | null; onChange: () => void; onCall?: () => void }) {
  const [busy, setBusy] = useState(false);
  const terminal = TERMINAL_STATUSES.includes(job.status);
  async function cmd(body: unknown, confirmMsg?: string) {
    if (confirmMsg && !confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await api(`/api/jobs/${job.id}/cmd`, body);
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <Link href="/" className="hover:text-fg">
          ← Wall
        </Link>
        <span>·</span>
        <span className="font-medium text-fg">{projectLabel(job.project)}</span>
        <span>·</span>
        <span>started {timeAgo(job.createdAt)}</span>
        <span className="ml-auto flex gap-1">
          <LocationBadge job={job} />
          <StatusChip status={job.status} />
        </span>
      </div>
      <h1 className="text-lg font-semibold leading-snug">{job.title}</h1>
      {job.task !== job.title && <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted">{job.task}</p>}
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
        <div className="flex w-48 items-center gap-2">
          <Bar value={job.costUsd} max={job.budgetUsd} />
          <span className="shrink-0">
            {usd(job.costUsd)}/{usd(job.budgetUsd)}
            {job.tokensIn + job.tokensOut > 0 && (<span className="ml-1.5" title={tokenTitle(job)}>· {tokens(job.tokensIn + job.tokensOut)} tokens</span>)}
          </span>
        </div>
        {job.cloudRunUrl && (
          <a href={job.cloudRunUrl} target="_blank" rel="noreferrer" className="text-accent">
            Actions run ↗
          </a>
        )}
        {job.mergeState !== "none" && <span>merge: {job.mergeState.replaceAll("_", " ")}</span>}
        {lease && <span>runner: {lease.startsWith("cloud") ? "cloud" : "PC"}</span>}
        <span className="ml-auto flex gap-2">
          {!terminal && (
            <button
              className={`btn ${job.autoMode ? "border-warn/60 text-warn" : ""}`}
              disabled={busy}
              title={job.autoMode ? "Permission requests are approved automatically. Click to ask again." : "Approve permission requests automatically"}
              onClick={() =>
                cmd(
                  { cmd: { type: "set_auto_mode", enabled: !job.autoMode } },
                  job.autoMode ? undefined : "Turn on auto mode? Agents can run shell commands and fetch web pages without asking (still only inside this job's folder). Requests already waiting are approved too.",
                )
              }
            >
              ⚡ Auto {job.autoMode ? "on" : "off"}
            </button>
          )}
          {onCall && (!terminal || job.status === "done") && (
            <button className="btn" onClick={onCall} title="Talk to the orchestrator and every agent at once">
              📞 Call
            </button>
          )}
          {!terminal && job.status !== "paused" && (
            <button className="btn" disabled={busy} onClick={() => cmd({ cmd: { type: "pause" } })}>
              Pause
            </button>
          )}
          {(job.status === "paused" || job.status === "failed") && (
            <button className="btn btn-primary" disabled={busy} onClick={() => cmd({ cmd: { type: "resume" } })}>
              Resume
            </button>
          )}
          {!terminal && job.kind === "chat" && job.status !== "merging" && (
            <button
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                cmd(
                  { cmd: { type: "finish_chat" } },
                  job.project === NO_PROJECT ? "End this chat?" : "End this chat and merge its changes into your PC's copy?",
                )
              }
            >
              {job.project === NO_PROJECT ? "End chat" : "Finish & merge"}
            </button>
          )}
          {!terminal && (
            <button
              className="btn btn-danger"
              disabled={busy}
              onClick={() => cmd({ cmd: { type: "cancel" } }, job.kind === "chat" ? "End this chat without merging? Its branch is kept." : "Cancel this job? Branches are kept.")}
            >
              {job.kind === "chat" ? "Discard" : "Cancel"}
            </button>
          )}
          {terminal && !job.archived && (
            <button className="btn" disabled={busy} onClick={() => cmd({ webAction: "archive" }, "Archive this job to GitHub and free its storage?")}>
              Archive
            </button>
          )}
        </span>
      </div>
      {job.summary && (
        <div className="card whitespace-pre-wrap p-3 text-sm">
          <div className="mb-1 text-xs font-semibold text-muted">Report</div>
          {job.summary}
        </div>
      )}
      {job.error && <div className="card border-bad/50 p-3 text-sm text-bad">{job.error}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- questions

function QuestionCard({ jobId, q, onDone }: { jobId: string; q: Approval; onDone: () => void }) {
  type Q = { question: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean };
  const questions = ((q.input.questions as Q[] | undefined) ?? []).filter((x) => x?.question);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const toggle = (qq: Q, label: string) =>
    setAnswers((a) => {
      if (!qq.multiSelect) return { ...a, [qq.question]: label };
      const cur = new Set((a[qq.question] ?? "").split(", ").filter(Boolean));
      if (cur.has(label)) cur.delete(label);
      else cur.add(label);
      return { ...a, [qq.question]: [...cur].join(", ") };
    });
  return (
    <div className="card space-y-3 border-warn/50 p-3">
      <div className="text-sm font-medium">{q.agentId === "orchestrator" ? "Orchestrator" : q.agentId === CHAT_AGENT ? "Claude" : `Worker ${q.agentId}`} has a question</div>
      {questions.map((qq) => (
        <div key={qq.question} className="space-y-1.5">
          <div className="text-sm">{qq.question}</div>
          <div className="flex flex-wrap gap-2">
            {(qq.options ?? []).map((o) => {
              const on = (answers[qq.question] ?? "").split(", ").includes(o.label);
              return (
                <button key={o.label} title={o.description} className={`btn ${on ? "btn-primary" : ""}`} onClick={() => toggle(qq, o.label)}>
                  {o.label}
                </button>
              );
            })}
          </div>
          <input
            className="input"
            placeholder="Or type your own answer"
            value={(qq.options ?? []).some((o) => o.label === answers[qq.question]) ? "" : (answers[qq.question] ?? "")}
            onChange={(e) => setAnswers((a) => ({ ...a, [qq.question]: e.target.value }))}
          />
        </div>
      ))}
      <button
        className="btn btn-primary"
        disabled={busy || questions.some((qq) => !answers[qq.question])}
        onClick={async () => {
          setBusy(true);
          try {
            await api(`/api/jobs/${jobId}/cmd`, { cmd: { type: "answer", requestId: q.requestId, answers } });
            onDone();
          } catch (e) {
            alert((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        Send answer
      </button>
    </div>
  );
}

// ---------------------------------------------------------------- timeline

const QUIET: WdEvent["type"][] = ["usage", "attention", "attention_cleared", "artifact", "diff", "permission_decision"];

type Row = { kind: "event"; e: WdEvent } | { kind: "sub"; id: string; type?: string; agentId?: string; events: WdEvent[] };

function Timeline({ events, agents }: { events: WdEvent[]; agents: AgentRecord[] }) {
  const [filter, setFilter] = useState<string>("all");
  const [follow, setFollow] = useState(true);

  const results = useMemo(() => {
    const m = new Map<string, WdEvent>();
    for (const e of events) if (e.type === "tool_result") m.set(String(e.payload.callId), e);
    return m;
  }, [events]);

  const answers = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      const a = e.type === "permission_decision" ? (e.payload.answers as Record<string, string> | undefined) : undefined;
      if (a) m.set(String(e.payload.requestId), [...new Set(Object.values(a))].join(" / "));
    }
    return m;
  }, [events]);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const e of events) {
      const shown = (e.type === "permission_decision" && e.payload.auto) || (e.type === "artifact" && e.payload.kind === "file");
      if ((QUIET.includes(e.type) && !shown) || e.type === "tool_result") continue;
      if (filter !== "all" && e.agentId !== filter && e.agentId) continue;
      if (e.subagentId) {
        const last = out.at(-1);
        if (last?.kind === "sub" && last.id === e.subagentId) last.events.push(e);
        else out.push({ kind: "sub", id: e.subagentId, type: e.subagentType, agentId: e.agentId, events: [e] });
      } else out.push({ kind: "event", e });
    }
    return out;
  }, [events, filter]);

  useEffect(() => {
    // To the true bottom of the page: the chat box sits below the timeline's end marker.
    if (follow) window.scrollTo({ top: document.documentElement.scrollHeight });
  }, [rows.length, follow]);

  // Scrolling up to read pauses follow (so new activity doesn't yank you back down); reaching the bottom resumes it.
  useEffect(() => {
    let lastY = window.scrollY;
    const onScroll = () => {
      const y = window.scrollY;
      const atBottom = window.innerHeight + y >= document.documentElement.scrollHeight - 120;
      if (y < lastY - 4 && !atBottom) setFollow(false);
      else if (atBottom && y > lastY) setFollow(true);
      lastY = y;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {["all", ...agents.map((a) => a.id)].map((a) => (
          <button key={a} onClick={() => setFilter(a)} className={`chip border ${filter === a ? "border-accent text-accent" : "border-line text-muted"}`}>
            {a}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1 text-xs text-muted">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> follow
        </label>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted">No activity yet.</p>}
      <div className="space-y-1.5">
        {rows.map((r, i) =>
          r.kind === "event" ? (
            <EventRow
              key={r.e.id ?? i}
              e={r.e}
              result={r.e.type === "tool_call" ? results.get(String(r.e.payload.callId)) : undefined}
              answer={r.e.type === "question" ? answers.get(String(r.e.payload.requestId)) : undefined}
            />
          ) : (
            <details key={`${r.id}-${i}`} className="card ml-4 border-dashed px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted">
                <AgentTag id={r.agentId} /> {r.type ?? "subagent"} subagent · {r.events.length} steps
              </summary>
              <div className="mt-2 space-y-1.5">
                {r.events.map((e, j) => (
                  <EventRow key={e.id ?? j} e={e} result={e.type === "tool_call" ? results.get(String(e.payload.callId)) : undefined} />
                ))}
              </div>
            </details>
          ),
        )}
      </div>
    </div>
  );
}

function AgentTag({ id }: { id?: string }) {
  if (!id) return <span className="font-mono text-[11px] text-muted">wdash</span>;
  return <span className={`font-mono text-[11px] ${id === "orchestrator" ? "text-accent" : "text-info"}`}>{id}</span>;
}

function EventRow({ e, result, answer }: { e: WdEvent; result?: WdEvent; answer?: string }) {
  const p = e.payload as Record<string, unknown>;
  const time = new Date(e.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const head = (
    <span className="mr-2 inline-flex items-center gap-1.5 text-[11px] text-muted">
      <span>{time}</span>
      {e.type === "message" && p.role === "user" ? (
        <>
          <span className="font-medium text-fg">you</span>→<AgentTag id={e.agentId} />
        </>
      ) : (
        <AgentTag id={e.agentId} />
      )}
    </span>
  );
  switch (e.type) {
    case "message":
      return (
        <div className={`rounded-lg px-3 py-2 text-sm ${p.role === "user" ? "ml-8 bg-accent/10" : "bg-panel"}`}>
          {head}
          <div className="mt-0.5 whitespace-pre-wrap break-words">{String(p.text ?? "")}</div>
        </div>
      );
    case "tool_call": {
      if (p.tool === "AskUserQuestion") return null;
      const ok = result ? (result.payload.ok as boolean) : undefined;
      return (
        <details className="rounded-lg bg-panel px-3 py-1.5 text-xs">
          <summary className="cursor-pointer">
            {head}
            <span className="font-mono">{String(p.tool)}</span>{" "}
            <span className="text-muted">{summarizeInput(p.input)}</span>
            {ok === false && <span className="ml-1 text-bad">✗</span>}
            {ok === undefined && <span className="ml-1 text-muted">…</span>}
          </summary>
          <pre className="code mt-1.5">{JSON.stringify(p.input, null, 2)}</pre>
          {result && <pre className="code mt-1.5 max-h-80">{String(result.payload.output ?? "")}</pre>}
        </details>
      );
    }
    case "permission_request":
      return (
        <div className="rounded-lg border border-warn/40 px-3 py-1.5 text-xs">
          {head}permission requested: <span className="font-mono">{String(p.title)}</span>
        </div>
      );
    case "artifact":
      return (
        <div className="rounded-lg bg-panel px-3 py-2 text-sm">
          {head}
          <a
            href={`/api/jobs/${e.jobId}/files/${String(p.fileId)}`}
            download={String(p.name)}
            className="mt-1 flex w-fit max-w-full items-center gap-2 rounded-lg border border-line px-3 py-2 hover:border-accent"
          >
            <span aria-hidden>📄</span>
            <span className="truncate font-medium">{String(p.name)}</span>
            <span className="shrink-0 text-xs text-muted">{fmtSize(Number(p.size ?? 0))} · download</span>
          </a>
          {p.note ? <p className="mt-1 text-xs text-muted">{String(p.note)}</p> : null}
        </div>
      );
    case "permission_decision":
      return (
        <div className="px-3 py-0.5 text-xs text-muted">
          {head}⚡ auto-approved: <span className="font-mono">{String(p.title)}</span>
        </div>
      );
    case "question":
      return (
        <div className="rounded-lg border border-warn/40 px-3 py-1.5 text-xs">
          {head}asked you: {String(p.title)}
          {answer && <div className="mt-1 text-fg">↳ {answer}</div>}
        </div>
      );
    case "plan":
      return (
        <div className="rounded-lg border border-accent/40 px-3 py-2 text-sm">
          {head}
          <span className="font-medium">Plan</span>
          <p className="mt-1 whitespace-pre-wrap text-muted">{String(p.summary)}</p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {((p.workers as Array<{ name: string; globs: string[]; task: string }>) ?? []).map((w) => (
              <li key={w.name}>
                <span className="font-mono">{w.name}</span> — {w.globs.join(", ")}
              </li>
            ))}
          </ul>
        </div>
      );
    case "board":
      return (
        <div className="px-3 py-1 text-xs text-muted">
          {head}
          <span className="font-mono">
            {String(p.from)} → {String(p.to)}
          </span>
          : <span className="whitespace-pre-wrap">{String(p.text)}</span>
        </div>
      );
    case "review": {
      if (p.verdict === "checks") {
        const checks = (p.checks as Array<{ name: string; ok: boolean; skipped?: boolean }>) ?? [];
        return (
          <div className="px-3 py-1 text-xs">
            {head}checks{p.scope === "final" ? " (combined)" : ""}:{" "}
            {checks.map((c) => (
              <span key={c.name} className={`mr-2 ${c.skipped ? "text-muted" : c.ok ? "text-ok" : "text-bad"}`}>
                {c.name} {c.skipped ? "–" : c.ok ? "✓" : "✗"}
              </span>
            ))}
          </div>
        );
      }
      return (
        <div className={`rounded-lg px-3 py-1.5 text-xs ${p.verdict === "approved" ? "text-ok" : "text-warn"}`}>
          {head}review of {String(p.worker)} round {String(p.round)}: {String(p.verdict).replaceAll("_", " ")}
          {typeof p.notes === "string" && <p className="mt-1 whitespace-pre-wrap text-muted">{p.notes}</p>}
        </div>
      );
    }
    case "status":
      return (
        <div className="px-3 text-[11px] text-muted">
          {head}
          {p.agent ? `${String(p.agent)} → ${String(p.status)}` : `job → ${String(p.status).replaceAll("_", " ")}`}
        </div>
      );
    case "checkpoint":
      return (
        <div className="px-3 text-[11px] text-muted">
          {head}checkpoint {String(p.sha).slice(0, 8)} ({String(p.why)})
        </div>
      );
    case "error":
      return (
        <div className="rounded-lg border border-bad/40 px-3 py-1.5 text-xs text-bad">
          {head}
          <span className="whitespace-pre-wrap">{String(p.detail)}</span>
        </div>
      );
    case "info":
      return (
        <div className="px-3 text-[11px] text-muted">
          {head}
          {String(p.text ?? p.stderr ?? "")}
        </div>
      );
    default:
      return null;
  }
}

function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? o.query ?? o.description ?? o.to ?? o.agent;
  const s = typeof v === "string" ? v : "";
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
}

// ---------------------------------------------------------------- team

function Team({ job, agents, events, claims, onChange }: { job: JobRecord; agents: AgentRecord[]; events: WdEvent[]; claims: Record<string, string>; onChange: () => void }) {
  const plan = [...events].reverse().find((e) => e.type === "plan");
  const board = events.filter((e) => e.type === "board").slice(-40);
  const [edits, setEdits] = useState("");
  const [busy, setBusy] = useState(false);
  async function approve(withEdits: boolean) {
    setBusy(true);
    try {
      await api(`/api/jobs/${job.id}/cmd`, { cmd: { type: "approve_plan", edits: withEdits ? edits : undefined } });
      setEdits("");
      onChange();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      {job.status === "awaiting_plan_approval" && plan && (
        <div className="card space-y-2 border-warn/50 p-3">
          <div className="text-sm font-medium">Plan waiting for your approval</div>
          <p className="whitespace-pre-wrap text-sm text-muted">{String(plan.payload.summary)}</p>
          <textarea className="input min-h-20" placeholder="Optional: changes you want (sent back to the orchestrator)" value={edits} onChange={(e) => setEdits(e.target.value)} />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => approve(false)}>
              Approve
            </button>
            <button className="btn" disabled={busy || !edits.trim()} onClick={() => approve(true)}>
              Send edits
            </button>
          </div>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {agents
          .sort((a, b) => (a.role === "orchestrator" ? -1 : b.role === "orchestrator" ? 1 : a.id.localeCompare(b.id)))
          .map((a) => (
            <div key={a.id} className="card space-y-1.5 p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{a.id}</span>
                <span className="text-xs text-muted">{a.model}</span>
                <span className="ml-auto">
                  <StatusChip status={a.status} />
                </span>
              </div>
              {a.role === "worker" && <p className="line-clamp-3 text-xs text-muted">{a.task}</p>}
              {a.globs.length > 0 && <div className="font-mono text-[11px] text-muted">owns: {a.globs.join(", ")}</div>}
              <div className="flex gap-3 text-[11px] text-muted">
                {a.role === "worker" && (
                  <span>
                    review {a.reviewRounds}/{job.reviewCap}
                  </span>
                )}
                <span>{usd(a.costUsd)}</span>
                <span>active {timeAgo(a.lastEventAt)}</span>
              </div>
            </div>
          ))}
      </div>
      {Object.keys(claims).length > 0 && (
        <details className="card p-3 text-xs">
          <summary className="cursor-pointer text-muted">File ownership ({Object.keys(claims).length})</summary>
          <ul className="mt-2 space-y-0.5 font-mono">
            {Object.entries(claims).map(([g, o]) => (
              <li key={g}>
                {g} → {o}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-muted">Board</h3>
        {board.length === 0 && <p className="text-xs text-muted">No messages between agents yet.</p>}
        {board.map((e, i) => (
          <EventRow key={e.id ?? i} e={e} />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- diffs

function Diffs({ events, job }: { events: WdEvent[]; job: JobRecord }) {
  const latest = new Map<string, WdEvent>();
  for (const e of events) if (e.type === "diff") latest.set(String(e.payload.branch), e);
  const shots = events.filter((e) => e.type === "artifact" && e.payload.kind === "screenshot").slice(-4);
  const branches = [...latest.keys()];
  const [sel, setSel] = useState<string>();
  const current = latest.get(sel ?? "") ?? (branches.length ? latest.get(branches.at(-1)!) : undefined);

  return (
    <div className="space-y-3">
      {job.mergeState === "needs_merge" && (
        <div className="card border-bad/50 p-3 text-sm">
          These changes couldn&apos;t merge into your checkout automatically. On your PC run:
          <pre className="code mt-2">git merge wdash/{job.id}/main</pre>
        </div>
      )}
      {branches.length === 0 ? (
        <p className="text-sm text-muted">No diffs yet. They appear when the orchestrator reviews work.</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {branches.map((b) => (
              <button key={b} onClick={() => setSel(b)} className={`chip border font-mono ${current === latest.get(b) ? "border-accent text-accent" : "border-line text-muted"}`}>
                {latest.get(b)?.payload.combined ? "combined" : b.split("/").at(-1)}
              </button>
            ))}
          </div>
          {current && <Patch e={current} />}
        </>
      )}
      {shots.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-muted">Screenshots</h3>
          <div className="grid gap-2 sm:grid-cols-2">
            {shots.map((s, i) => (
              <figure key={s.id ?? i} className="card overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`data:image/png;base64,${String(s.payload.png)}`} alt={`Screenshot from ${s.agentId}`} className="w-full" />
                <figcaption className="px-2 py-1 text-[11px] text-muted">
                  {s.agentId} · {new Date(s.ts).toLocaleString()}
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Patch({ e }: { e: WdEvent }) {
  const files = (e.payload.files as Array<{ status: string; path: string }>) ?? [];
  const patch = String(e.payload.patch ?? "");
  return (
    <div className="space-y-2">
      <ul className="card divide-y divide-line text-xs">
        {files.map((f) => (
          <li key={f.path} className="flex gap-2 px-3 py-1.5 font-mono">
            <span className={f.status.startsWith("A") ? "text-ok" : f.status.startsWith("D") ? "text-bad" : "text-warn"}>{f.status}</span>
            {f.path}
          </li>
        ))}
      </ul>
      <pre className="code max-h-[70vh]">
        {patch.split("\n").map((l, i) => (
          <div
            key={i}
            className={
              l.startsWith("+") && !l.startsWith("+++")
                ? "bg-ok/10 text-ok"
                : l.startsWith("-") && !l.startsWith("---")
                  ? "bg-bad/10 text-bad"
                  : l.startsWith("@@")
                    ? "text-info"
                    : l.startsWith("diff ")
                      ? "mt-2 font-semibold"
                      : ""
            }
          >
            {l || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------- usage

function Usage({ job, agents, usage }: { job: JobRecord; agents: AgentRecord[]; usage: Detail["usage"] }) {
  return (
    <div className="space-y-3">
      <div className="card space-y-2 p-3">
        <div className="flex items-center justify-between text-sm">
          <span>Job budget</span>
          <span>
            {usd(job.costUsd)} of {usd(job.budgetUsd)}
          </span>
        </div>
        <Bar value={job.costUsd} max={job.budgetUsd} />
        <div className="flex items-center justify-between text-sm">
          <span>Tokens</span>
          <span title={tokenTitle(job)}>
            {tokens(job.tokensIn + job.tokensOut)} <span className="text-xs text-muted">({tokens(job.tokensIn)} in · {tokens(job.tokensOut)} out)</span>
          </span>
        </div>
        <p className="text-xs text-muted">Input includes cached context, which is most of it and much cheaper than new tokens. API-equivalent cost estimated by the Agent SDK. It runs on your subscription; this is how wdash measures how much of it a job uses.</p>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-muted">
            <tr>
              {["agent", "model", "cost", "in", "out", "cache read", "cache write", "turns"].map((h) => (
                <th key={h} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {agents.map((a) => {
              const u = usage[a.id] ?? {};
              return (
                <tr key={a.id}>
                  <td className="px-3 py-1.5 font-mono">{a.id}</td>
                  <td className="px-3 py-1.5">{a.model}</td>
                  <td className="px-3 py-1.5">{usd(Number(u.costUsd ?? a.costUsd))}</td>
                  <td className="px-3 py-1.5">{fmt(u.inputTokens)}</td>
                  <td className="px-3 py-1.5">{fmt(u.outputTokens)}</td>
                  <td className="px-3 py-1.5">{fmt(u.cacheReadTokens)}</td>
                  <td className="px-3 py-1.5">{fmt(u.cacheWriteTokens)}</td>
                  <td className="px-3 py-1.5">{String(u.turns ?? "—")}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function fmt(n: unknown): string {
  const v = Number(n ?? 0);
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);
}

// ---------------------------------------------------------------- chat

/** "claude is working…" with the latest step, so it's obvious something is happening. */
function Working({ agents, events }: { agents: AgentRecord[]; events: WdEvent[] }) {
  const busy = agents.filter((a) => a.status === "running" || a.status === "starting");
  if (!busy.length) return null;
  const ids = new Set(busy.map((a) => a.id));
  const last = [...events].reverse().find((e) => e.agentId && ids.has(e.agentId) && (e.type === "tool_call" || e.type === "message"));
  const step =
    last?.type === "tool_call"
      ? `${String(last.payload.tool)} ${summarizeInput(last.payload.input)}`.trim()
      : last?.type === "message" && last.payload.role !== "user"
        ? "writing a reply"
        : "thinking";
  return (
    <div className="flex items-center gap-2 px-1 text-xs text-muted" role="status" aria-live="polite">
      <span className="flex gap-1" aria-hidden>
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
      </span>
      <span className="truncate">
        <span className="font-medium text-fg">{busy.map((a) => a.id).join(", ")}</span> {busy.length === 1 ? "is" : "are"} working… {step && <span>({step})</span>}
      </span>
    </div>
  );
}

function JobFiles({ jobId, files }: { jobId: string; files: Attachment[] }) {
  if (!files.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted">Files:</span>
      {files.map((f) => (
        <a key={f.id} href={`/api/jobs/${jobId}/files/${f.id}`} className="rounded-lg border border-line px-2 py-1 hover:border-accent" download={f.name}>
          {f.from ? "📄 " : ""}
          {f.name} <span className="text-muted">{fmtSize(f.size)}</span>
        </a>
      ))}
    </div>
  );
}

function ChatBox({ jobId, agents, lead, asking, reopen = false }: { jobId: string; agents: AgentRecord[]; lead: string; asking: string[]; reopen?: boolean }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState(lead);
  const [busy, setBusy] = useState(false);
  const files = useUploads(`/api/jobs/${jobId}/files`);
  const live = agents.filter((a) => !["done", "stopped"].includes(a.status));
  const canSend = !busy && !files.busy && (!!text.trim() || files.ready.length > 0);
  return (
    <form
      className="sticky bottom-[calc(0.5rem+env(safe-area-inset-bottom))] z-10 space-y-2 rounded-xl border border-line bg-panel p-2 shadow-lg"
      {...dropProps(files.add)}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!canSend) return;
        setBusy(true);
        try {
          const attachments = files.ready.map((f) => f.id);
          const msg = text.trim() || `Attached: ${files.ready.map((f) => f.name).join(", ")}`;
          await api(`/api/jobs/${jobId}/cmd`, {
            cmd: { type: "user_message", text: msg, agentId: to, attachments: attachments.length ? attachments : undefined },
          });
          setText("");
          files.clear();
        } catch (err) {
          alert((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <FileChips items={files.items} onRemove={files.remove} />
      <div className="flex gap-2">
        <AttachButton onFiles={files.add} compact />
        {agents.length > 1 && (
          <select className="input w-auto max-w-36" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Send to">
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.id}
                {live.includes(a) ? "" : " (wakes up)"}
              </option>
            ))}
            <option value="*">everyone</option>
          </select>
        )}
        <input data-chat-input className="input" placeholder={reopen ? `Follow up with ${to}… (reopens the job)` : asking.includes(to) ? `Answer ${to}'s question…` : `Message ${to}…`} value={text} onChange={(e) => setText(e.target.value)} />
        <button data-chat-send className="btn btn-primary" disabled={!canSend}>
          Send
        </button>
      </div>
    </form>
  );
}
