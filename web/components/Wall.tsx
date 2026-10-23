"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord, Attention, AttentionAction, JobRecord, WdEvent } from "@wdash/shared";
import { projectLabel } from "@wdash/shared";
import { api, usd } from "@/lib/client";
import { useBoard } from "./Shell";

// The wall: every agent across every live job as a terminal tile streaming its output.

type WallResponse = {
  jobs: Array<{ job: JobRecord; agents: AgentRecord[] }>;
  events: Record<string, WdEvent[]>;
  cursors: Record<string, string>;
  now: number;
};

type Line = { key: string; ts: number; tone: Tone; text: string; sub?: string };
type Tone = "fg" | "muted" | "tool" | "ok" | "bad" | "warn" | "user" | "plan";

const MAX_LINES = 400;
const SIZES = { S: { min: 240, h: 190 }, M: { min: 320, h: 260 }, L: { min: 440, h: 360 } } as const;
type Size = keyof typeof SIZES;
const PREFS = "wdash:wall";

const TONE: Record<Tone, string> = {
  fg: "text-[#d6dae0]",
  muted: "text-[#7d8590]",
  tool: "text-[#67e8f9]",
  ok: "text-[#4ade80]",
  bad: "text-[#f87171]",
  warn: "text-[#fbbf24]",
  user: "text-[#a5b4fc]",
  plan: "text-[#c4b5fd]",
};

const STATUS_DOT: Record<string, string> = {
  running: "bg-[#4ade80] animate-pulse",
  starting: "bg-[#4ade80]",
  reviewing: "bg-[#67e8f9] animate-pulse",
  idle: "bg-[#7d8590]",
  waiting_on_user: "bg-[#fbbf24] animate-pulse",
  waiting_on_approval: "bg-[#fbbf24] animate-pulse",
  failed: "bg-[#f87171]",
  done: "bg-[#4ade80]/40",
  stopped: "bg-[#7d8590]/40",
};

export function Wall() {
  const { state, refresh: refreshBoard } = useBoard();
  const [jobs, setJobs] = useState<WallResponse["jobs"]>([]);
  const [lines, setLines] = useState<Record<string, Line[]>>({});
  const cursors = useRef<Record<string, string>>({});
  const [size, setSize] = useState<Size>("M");
  const [project, setProject] = useState("all");
  const [hideDone, setHideDone] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const wallRef = useRef<HTMLDivElement>(null);

  // Per-viewer prefs (tile size, filters); storage may be unavailable.
  useEffect(() => {
    try {
      const p = JSON.parse(localStorage.getItem(PREFS) ?? "{}") as { size?: Size; hideDone?: boolean };
      if (p.size && p.size in SIZES) setSize(p.size);
      if (typeof p.hideDone === "boolean") setHideDone(p.hideDone);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(PREFS, JSON.stringify({ size, hideDone }));
    } catch {
      /* ignore */
    }
  }, [size, hideDone]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    // 2 s while output is flowing, backing off to 8 s when quiet (each poll costs Upstash commands).
    let delay = 2000;
    const loop = async () => {
      if (stop) return;
      if (document.visibilityState === "visible") {
        try {
          const res = await api<WallResponse>(`/api/wall?c=${encodeURIComponent(JSON.stringify(cursors.current))}`);
          if (stop) return;
          cursors.current = res.cursors;
          setJobs(res.jobs);
          setLines((prev) => mergeLines(prev, res));
          setLoaded(true);
          const busy = Object.values(res.events).some((e) => e.length > 0);
          delay = busy ? 2000 : Math.min(delay * 1.5, 8000);
        } catch {
          /* retry next tick */
        }
      }
      timer = setTimeout(loop, delay);
    };
    void loop();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  const attentionByTile = useMemo(() => {
    const m = new Map<string, Attention[]>();
    for (const a of state?.attention ?? []) {
      const k = tileKey(a.jobId, a.agentId ?? "orchestrator");
      m.set(k, [...(m.get(k) ?? []), a]);
    }
    return m;
  }, [state?.attention]);

  const projects = [...new Set(jobs.map((j) => j.job.project))].sort();
  const tiles = jobs
    .filter((j) => project === "all" || j.job.project === project)
    .flatMap(({ job, agents }) => {
      const list = agents.length ? agents : [placeholderAgent()];
      return list
        .filter((a) => !hideDone || !["done", "stopped"].includes(a.status) || attentionByTile.has(tileKey(job.id, a.id)))
        .sort((a, b) => (a.role === "orchestrator" ? -1 : b.role === "orchestrator" ? 1 : a.id.localeCompare(b.id)))
        .map((agent) => ({ job, agent, key: tileKey(job.id, agent.id) }));
    });

  const running = tiles.filter((t) => ["running", "starting", "reviewing"].includes(t.agent.status)).length;
  const waiting = tiles.filter((t) => attentionByTile.has(t.key)).length;
  const dims = SIZES[size];

  return (
    <div ref={wallRef} className="wall -mx-4 min-h-[calc(100dvh-12rem)] bg-[#06080a] p-2 sm:p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 px-1 font-mono text-xs text-[#7d8590]">
        <span className="text-[#d6dae0]">{tiles.length} agents</span>
        <span className="text-[#4ade80]">{running} running</span>
        {waiting > 0 && <span className="text-[#fbbf24]">{waiting} need you</span>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {projects.length > 1 && (
            <select value={project} onChange={(e) => setProject(e.target.value)} className="rounded border border-[#2a2f39] bg-[#0d1014] px-1.5 py-0.5 text-[#d6dae0]">
              <option value="all">all projects</option>
              {projects.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          )}
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> hide finished
          </label>
          <span className="flex overflow-hidden rounded border border-[#2a2f39]">
            {(Object.keys(SIZES) as Size[]).map((s) => (
              <button key={s} onClick={() => setSize(s)} className={`px-2 py-0.5 ${size === s ? "bg-[#2a2f39] text-[#d6dae0]" : ""}`}>
                {s}
              </button>
            ))}
          </span>
          <button
            className="rounded border border-[#2a2f39] px-2 py-0.5 hover:text-[#d6dae0]"
            onClick={() => {
              const p = document.fullscreenElement ? document.exitFullscreen() : wallRef.current?.requestFullscreen();
              p?.catch(() => undefined);
            }}
          >
            ⛶ fullscreen
          </button>
        </span>
      </div>

      {!loaded ? (
        <p className="p-4 font-mono text-sm text-[#7d8590]">connecting…</p>
      ) : tiles.length === 0 ? (
        <div className="p-8 text-center font-mono text-sm text-[#7d8590]">
          no live agents. type a task in the box above to start one.
        </div>
      ) : (
        <div className="grid gap-1.5 sm:gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(min(100%, ${dims.min}px), 1fr))` }}>
          {tiles.map((t, i) => (
            <Tile
              key={t.key}
              n={i < 5 ? i + 1 : undefined}
              job={t.job}
              agent={t.agent}
              lines={lines[t.key] ?? []}
              attention={attentionByTile.get(t.key) ?? []}
              height={dims.h}
              onActed={refreshBoard}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function Tile({
  n,
  job,
  agent,
  lines,
  attention,
  height,
  onActed,
}: {
  /** 1-5: shown as a badge; holding up that many fingers (camera gestures) opens the tile. */
  n?: number;
  job: JobRecord;
  agent: AgentRecord;
  lines: Line[];
  attention: Attention[];
  height: number;
  onActed: () => void;
}) {
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const needsYou = attention.length > 0;
  const dim = ["done", "stopped"].includes(agent.status);

  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

  return (
    <section
      className={`flex flex-col overflow-hidden rounded-md border font-mono text-[11px] leading-[1.45] ${
        needsYou ? "border-[#fbbf24] shadow-[0_0_0_1px_#fbbf24,0_0_14px_-2px_#fbbf2466]" : agent.status === "failed" ? "border-[#f87171]/70" : "border-[#1f242c]"
      } ${dim ? "opacity-60" : ""} bg-[#0b0d10]`}
      style={{ height }}
      data-wall-tile={n}
      data-href={`/jobs/${job.id}`}
      data-label={`${agent.id} · ${job.title.slice(0, 40)}`}
    >
      <Link href={`/jobs/${job.id}`} className="flex items-center gap-1.5 border-b border-[#1f242c] bg-[#0f1216] px-2 py-1 hover:bg-[#151a20]">
        {n && (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-[#2a2f39] text-[10px] font-semibold text-[#d6dae0]" title={`Hold up ${n} finger${n === 1 ? "" : "s"} to open`}>
            {n}
          </span>
        )}
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[agent.status] ?? "bg-[#7d8590]"}`} />
        <span className={agent.role === "orchestrator" ? "text-[#c4b5fd]" : "text-[#67e8f9]"}>{agent.id}</span>
        <span className="truncate text-[#7d8590]">
          {projectLabel(job.project)} · {job.title}
        </span>
        <span className="ml-auto shrink-0 text-[#7d8590]">
          {agent.model} {usd(agent.costUsd)}
        </span>
      </Link>
      <div
        ref={body}
        className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {lines.length === 0 && <div className="text-[#7d8590]">waiting for output…</div>}
        {lines.map((l) => (
          <div key={l.key} className={`whitespace-pre-wrap break-words ${TONE[l.tone]} ${l.sub ? "border-l border-[#2a2f39] pl-2" : ""}`}>
            {l.sub && <span className="text-[#7d8590]">[{l.sub}] </span>}
            {l.text}
          </div>
        ))}
      </div>
      {needsYou && <TileActions att={attention[0]!} more={attention.length - 1} onActed={onActed} />}
    </section>
  );
}

/** Inline buttons for the tile's most recent stop; anything needing text opens the job page. */
function TileActions({ att, more, onActed }: { att: Attention; more: number; onActed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  async function run(a: AttentionAction) {
    setBusy(true);
    setErr(undefined);
    try {
      if (a.webAction) await api(`/api/jobs/${att.jobId}/cmd`, { webAction: a.webAction });
      else if (a.cmd) await api(`/api/jobs/${att.jobId}/cmd`, { cmd: a.cmd });
      onActed();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="border-t border-[#fbbf24]/50 bg-[#1a1608] px-2 py-1.5">
      <div className="truncate text-[#fbbf24]" title={att.body}>
        ⚠ {att.title}
        {att.body ? `: ${att.body}` : ""}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {att.actions.map((a) =>
          a.href || a.needsText ? (
            <Link key={a.label} href={a.href ?? `/jobs/${att.jobId}`} className="rounded border border-[#2a2f39] px-1.5 py-0.5 text-[#d6dae0] hover:bg-[#2a2f39]">
              {a.label}
            </Link>
          ) : (
            <button
              key={a.label}
              disabled={busy}
              onClick={() => void run(a)}
              className={`rounded px-1.5 py-0.5 disabled:opacity-50 ${
                a.style === "primary" ? "bg-[#fbbf24] text-black" : a.style === "danger" ? "border border-[#f87171]/60 text-[#f87171]" : "border border-[#2a2f39] text-[#d6dae0]"
              }`}
            >
              {a.label}
            </button>
          ),
        )}
        {more > 0 && (
          <Link href={`/jobs/${att.jobId}`} className="px-1 py-0.5 text-[#7d8590]">
            +{more} more
          </Link>
        )}
      </div>
      {err && <div className="text-[#f87171]">{err}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- event → terminal lines

function tileKey(jobId: string, agentId: string): string {
  return `${jobId}/${agentId}`;
}

function placeholderAgent(): AgentRecord {
  return { id: "orchestrator", role: "orchestrator", model: "", name: "orchestrator", task: "", globs: [], status: "starting", reviewRounds: 0, lastEventAt: 0, costUsd: 0 };
}

function mergeLines(prev: Record<string, Line[]>, res: WallResponse): Record<string, Line[]> {
  const next = { ...prev };
  for (const [jobId, events] of Object.entries(res.events)) {
    const failedCalls = new Set(events.filter((e) => e.type === "tool_result" && e.payload.ok === false).map((e) => String(e.payload.callId)));
    for (const e of events) {
      const line = toLine(e, failedCalls);
      if (!line) continue;
      const k = tileKey(jobId, e.agentId ?? "orchestrator");
      const arr = next[k] === prev[k] ? [...(prev[k] ?? [])] : next[k]!;
      if (arr.some((l) => l.key === line.key)) continue; // backfill overlap
      arr.push(line);
      if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
      next[k] = arr;
    }
  }
  return next;
}

function toLine(e: WdEvent, failedCalls: Set<string>): Line | undefined {
  const p = e.payload as Record<string, unknown>;
  const base = { key: e.id ?? `${e.ts}-${e.type}`, ts: e.ts, sub: e.subagentId ? (e.subagentType ?? "sub") : undefined };
  const clip = (s: string, n = 700) => (s.length > n ? `${s.slice(0, n)}…` : s);
  switch (e.type) {
    case "message":
      return p.role === "user"
        ? { ...base, tone: "user", text: `› you: ${clip(String(p.text ?? ""))}` }
        : { ...base, tone: "fg", text: clip(String(p.text ?? "")) };
    case "tool_call": {
      const tool = String(p.tool);
      const failed = failedCalls.has(String(p.callId));
      const arg = toolArg(p.input);
      const shell = tool === "Bash" || tool === "PowerShell";
      const shown = tool.startsWith("mcp__wdash__") ? tool.slice("mcp__wdash__".length) : tool;
      return { ...base, tone: failed ? "bad" : "tool", text: `${shell ? "$" : "●"} ${shell ? arg : `${shown} ${arg}`}${failed ? "  ✗" : ""}` };
    }
    case "tool_result":
      return p.ok === false ? { ...base, tone: "bad", text: `  ✗ ${clip(String(p.output ?? "").split("\n").find((l) => l.trim()) ?? "failed", 200)}` } : undefined;
    case "permission_request":
      return { ...base, tone: "warn", text: `⚠ needs permission: ${String(p.title)}` };
    case "permission_decision":
      return { ...base, tone: p.allow ? "ok" : "bad", text: p.answers ? "✓ answered" : p.allow ? "✓ allowed" : "✗ denied" };
    case "question":
      return { ...base, tone: "warn", text: `? asks you: ${String(p.title)}` };
    case "plan": {
      const ws = (p.workers as Array<{ name: string }> | undefined) ?? [];
      return { ...base, tone: "plan", text: `▣ plan (${ws.length} worker${ws.length === 1 ? "" : "s"}: ${ws.map((w) => w.name).join(", ")})\n  ${clip(String(p.summary ?? ""), 300)}` };
    }
    case "board":
      return { ...base, tone: "muted", text: `→ ${String(p.to)}: ${clip(String(p.text ?? ""), 300)}` };
    case "review": {
      if (p.verdict === "checks") {
        const cs = (p.checks as Array<{ name: string; ok: boolean; skipped?: boolean }>) ?? [];
        const ok = cs.every((c) => c.ok);
        return { ...base, tone: ok ? "ok" : "bad", text: `checks${p.scope === "final" ? " (combined)" : ""}: ${cs.map((c) => `${c.name} ${c.skipped ? "–" : c.ok ? "✓" : "✗"}`).join("  ")}` };
      }
      return p.verdict === "approved"
        ? { ...base, tone: "ok", text: `✓ approved ${String(p.worker)}` }
        : { ...base, tone: "warn", text: `↺ changes requested for ${String(p.worker)} (round ${String(p.round)})` };
    }
    case "diff":
      return { ...base, tone: "muted", text: `± diff ${((p.files as unknown[]) ?? []).length} files${p.combined ? " (combined)" : ""}` };
    case "status":
      if (p.agent) return { ...base, tone: p.status === "failed" ? "bad" : "muted", text: `· ${String(p.status).replaceAll("_", " ")}` };
      return { ...base, tone: p.status === "failed" ? "bad" : p.status === "done" ? "ok" : "muted", text: `· job ${String(p.status).replaceAll("_", " ")}` };
    case "checkpoint":
      return { ...base, tone: "muted", text: `⟲ checkpoint ${String(p.sha).slice(0, 8)}` };
    case "error":
      return { ...base, tone: "bad", text: `✗ ${clip(String(p.detail ?? ""), 400)}` };
    case "info":
      return { ...base, tone: "muted", text: `# ${clip(String(p.text ?? p.stderr ?? ""), 300)}` };
    default:
      return undefined;
  }
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.pattern ?? o.path ?? o.url ?? o.query ?? o.description ?? o.agent ?? o.to ?? o.summary;
  const s = typeof v === "string" ? v.replace(/\s+/g, " ") : "";
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}
