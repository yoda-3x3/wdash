"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { NO_PROJECT, type JobKind, type ProjectConfig } from "@wdash/shared";
import { api, usePoll } from "@/lib/client";
import { AttachButton, FileChips, dropProps, useUploads } from "./Attachments";
import { ApproveAll, Bar } from "./bits";
import { useBoard } from "./Shell";
import { Wall } from "./Wall";

// Shared with the full New job form, so both remember the same choices.
export const PREFS = { project: "wdash:lastProject", kind: "wdash:lastKind", auto: "wdash:autoMode", lite: "wdash:lite" } as const;

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const put = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
};

/** Home: one line to start work, the account-wide controls, then the Wall. */
export function Home() {
  return (
    <div className="space-y-2">
      <QuickStart />
      <StatusStrip />
      <Wall />
    </div>
  );
}

/**
 * Type, Enter, done. Team jobs start with the cheap preset (Sonnet orchestrator + Haiku workers) and auto
 * mode on unless changed on the full form; chats open their page so you can keep talking.
 */
function QuickStart() {
  const router = useRouter();
  const { data } = usePoll<{ projects: ProjectConfig[] }>("/api/projects", 60_000);
  const projects = data?.projects ?? [];
  const [kind, setKind] = useState<JobKind>("team");
  const [project, setProject] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string>();
  const [lite, setLite] = useState(false);
  const files = useUploads("/api/uploads");
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (get(PREFS.kind) === "chat") setKind("chat");
    setLite(get(PREFS.lite) === "1");
  }, []);
  useEffect(() => {
    if (project || !data) return;
    const last = get(PREFS.project);
    const names = projects.map((p) => p.name);
    setProject(last && (names.includes(last) || (last === NO_PROJECT && kind === "chat")) ? last : (names[0] ?? NO_PROJECT));
  }, [data, projects, project, kind]);
  // Team jobs need a real project.
  useEffect(() => {
    if (kind === "team" && project === NO_PROJECT && projects[0]) setProject(projects[0].name);
  }, [kind, project, projects]);

  async function start() {
    const task = text.trim();
    if (!task || !project || busy || files.busy) return;
    setBusy(true);
    setNote(undefined);
    try {
      put(PREFS.project, project);
      put(PREFS.kind, kind);
      const auto = get(PREFS.auto) !== "0"; // on unless turned off
      const res = await api<{ id: string }>("/api/jobs", {
        project,
        task,
        kind,
        models: "sonnet-haiku",
        chatModel: "sonnet",
        workers: "auto",
        runOn: "auto",
        autoMode: auto,
        lite,
        attachments: files.ready.map((f) => f.id),
      });
      setText("");
      files.clear();
      if (kind === "chat") router.push(`/jobs/${res.id}`);
      else setNote("Started. It'll appear on the Wall in a moment.");
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="card space-y-2 p-2"
      {...dropProps(files.add)}
      onSubmit={(e) => {
        e.preventDefault();
        void start();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex overflow-hidden rounded-lg border border-line text-sm">
          {(["team", "chat"] as const).map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={`px-3 py-1.5 ${kind === k ? "bg-panel-2 font-medium" : "text-muted"}`}>
              {k === "team" ? "Team job" : "Chat"}
            </button>
          ))}
        </span>
        <select className="input w-auto max-w-[45%] py-1.5 text-sm" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          {kind === "chat" && <option value={NO_PROJECT}>No project</option>}
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`rounded-lg border px-2 py-1 text-xs ${lite ? "border-accent/60 text-accent" : "border-line text-muted"}`}
          title="Low usage mode: fewer tools, low effort, short prompts, one worker. Uses far fewer tokens."
          aria-pressed={lite}
          onClick={() => {
            setLite(!lite);
            put(PREFS.lite, lite ? "0" : "1");
          }}
        >
          🪶 Low usage {lite ? "on" : "off"}
        </button>
        <Link href={kind === "chat" ? "/chat/new" : "/new"} className="ml-auto text-xs text-muted hover:text-fg">
          More options
        </Link>
        <Link href="/projects/new" className="text-xs text-accent">
          + Project
        </Link>
      </div>
      <div className="flex items-end gap-2">
        <AttachButton onFiles={files.add} compact />
        <textarea
          ref={box}
          rows={1}
          className="input max-h-40 min-h-10 resize-none py-2"
          placeholder={kind === "chat" ? "Ask anything… (Enter to start, Shift+Enter for a new line)" : "What should the agents do? (Enter to start)"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = "auto";
            e.target.style.height = `${e.target.scrollHeight}px`;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <button className="btn btn-primary shrink-0 py-2" disabled={busy || files.busy || !text.trim() || !project}>
          {busy ? "…" : "Go"}
        </button>
      </div>
      <FileChips items={files.items} onRemove={files.remove} />
      {note && <p className="px-1 text-xs text-muted">{note}</p>}
    </form>
  );
}

/** Claude usage, Approve all, and Pause all in one line. */
function StatusStrip() {
  const { state, refresh } = useBoard();
  const [busy, setBusy] = useState(false);
  if (!state) return null;
  const shown = state.rateLimits.filter((r) => typeof r.utilization === "number" || typeof r.resetsAt === "number");
  const pct = (u?: number) => ((u ?? 0) <= 1 ? (u ?? 0) * 100 : (u ?? 0));
  return (
    <div className="flex flex-wrap items-center gap-3 px-1 text-xs text-muted">
      {shown.map((r) => (
        <span key={r.rateLimitType} className="flex items-center gap-1.5" title="Claude subscription usage">
          {(r.rateLimitType ?? "usage").replaceAll("_", " ")}
          <span className="w-16">
            <Bar value={pct(r.utilization)} max={100} />
          </span>
          {Math.round(pct(r.utilization))}%
          {typeof r.resetsAt === "number" && <span className="text-fg/70">· {resetLabel(r.resetsAt)}</span>}
        </span>
      ))}
      <span className="ml-auto flex items-center gap-2">
        <ApproveAll items={state.attention} onDone={refresh} />
        <button
          className={`btn py-1 text-xs ${state.paused ? "btn-primary" : ""}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api("/api/pause", { paused: !state.paused });
              refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          {state.paused ? "Resume all" : "Pause all"}
        </button>
      </span>
    </div>
  );
}

/** "resets 7:40 PM · in 2h 13m" (resetsAt is unix seconds from the SDK; ms tolerated). */
function resetLabel(resetsAt: number): string {
  const at = resetsAt > 1e12 ? resetsAt : resetsAt * 1000;
  const left = at - Date.now();
  if (left <= 0) return "reset now";
  const sameDay = new Date(at).toDateString() === new Date().toDateString();
  const when = new Date(at).toLocaleString([], sameDay ? { hour: "numeric", minute: "2-digit" } : { weekday: "short", hour: "numeric", minute: "2-digit" });
  const h = Math.floor(left / 3_600_000);
  const m = Math.round((left % 3_600_000) / 60_000);
  return `resets ${when} · in ${h ? `${h}h ` : ""}${m}m`;
}
