"use client";

import { useEffect, useRef, useState } from "react";
import { CHAT_AGENT, NO_PROJECT, type AgentRecord, type JobRecord, type ProjectConfig, type WdEvent } from "@wdash/shared";
import { api, usd } from "@/lib/client";
import { CLI_MODE, setFlag } from "@/lib/prefs";
import { useBoard } from "./Shell";
import { expandSlash, useSkills } from "./Skills";

/**
 * "Look exactly like the CLI" (Settings): the whole site as one Claude Code-style terminal.
 * Everything is a slash command; plain text goes to the open job's lead agent. /exit returns to the normal site.
 */
type Line = { kind: "out" | "in" | "err" | "dim" | "ok"; text: string };

const HELP: Array<[string, string]> = [
  ["/jobs", "list jobs (numbered)"],
  ["/open <n|id>", "open a job's transcript; then just type to talk to its agent"],
  ["/back", "close the open job"],
  ["/chat <message>", "start a chat (no project)"],
  ["/new <task>", "start a team job in the last project (/project to pick it)"],
  ["/project [name]", "show or pick the project for /new"],
  ["/model [opus|sonnet|haiku|free]", "model for /chat and /new"],
  ["/inbox", "what needs you"],
  ["/allow", "allow every pending permission request"],
  ["/skills", "list skills; /<skill> <text> runs one in the open job"],
  ["/clear", "clear the screen"],
  ["/exit", "leave CLI mode (back to the normal site)"],
];

const MODEL_KEY = "wdash:cliModel";
const PROJECT_KEY = "wdash:lastProject";

export function Terminal() {
  const { state, refresh } = useBoard();
  const skills = useSkills();
  const [lines, setLines] = useState<Line[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const [openId, setOpenId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { events, agents } = useJobStream(openId);
  const jobs = state?.jobs ?? [];
  const openJob = jobs.find((j) => j.id === openId);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [lines, events.length]);

  const print = (...l: Line[]) => setLines((prev) => [...prev, ...l].slice(-600));
  const pref = (k: string, d: string) => {
    try {
      return localStorage.getItem(k) || d;
    } catch {
      return d;
    }
  };
  const save = (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage blocked */
    }
  };

  async function run(raw: string) {
    const text = raw.trim();
    if (!text) return;
    print({ kind: "in", text });
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 50));
    setHi(-1);
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = text.slice(cmd!.length).trim();

    if (!text.startsWith("/")) {
      if (!openId) return print({ kind: "dim", text: "No job open. /open <n> a job, /chat <message> to start one, or /help." });
      return send(openId, text);
    }
    switch (cmd) {
      case "/help":
      case "/?":
        return print(...HELP.map(([c, d]) => ({ kind: "out" as const, text: `  ${c.padEnd(34)}${d}` })));
      case "/exit":
      case "/quit":
        setFlag(CLI_MODE, false);
        return;
      case "/clear":
        setLines([]);
        return;
      case "/jobs":
        if (!jobs.length) return print({ kind: "dim", text: "No jobs yet." });
        return print(
          ...jobs.slice(0, 30).map((j, i) => ({
            kind: "out" as const,
            text: `  ${String(i + 1).padStart(2)}  ${statusGlyph(j)} ${j.title.slice(0, 60).padEnd(60)} ${j.status.padEnd(12)} ${usd(j.costUsd)}`,
          })),
        );
      case "/open": {
        const j = pickJob(jobs, arg);
        if (!j) return print({ kind: "err", text: `No job "${arg}". /jobs lists them.` });
        setOpenId(j.id);
        setLines([]);
        return;
      }
      case "/back":
        setOpenId(undefined);
        return print({ kind: "dim", text: "Closed the job." });
      case "/inbox": {
        const att = state?.attention ?? [];
        if (!att.length) return print({ kind: "ok", text: "Nothing needs you." });
        return print(...att.map((a) => ({ kind: "out" as const, text: `  ❗ ${a.title} — ${a.body.slice(0, 100)}  (/open ${a.jobId})` })));
      }
      case "/allow": {
        const perms = (state?.attention ?? []).filter((a) => a.reason === "permission" && a.ref);
        if (!perms.length) return print({ kind: "dim", text: "No permission requests waiting." });
        for (const a of perms) await api(`/api/jobs/${a.jobId}/cmd`, { cmd: { type: "decide", requestId: a.ref, allow: true, scope: "once" } }).catch(() => undefined);
        refresh();
        return print({ kind: "ok", text: `Allowed ${perms.length} request${perms.length === 1 ? "" : "s"}.` });
      }
      case "/skills":
        if (!skills.length) return print({ kind: "dim", text: "No skills published yet (the PC daemon publishes them when it starts)." });
        return print(...skills.map((s) => ({ kind: "out" as const, text: `  /${s.name.padEnd(30)}${s.description.slice(0, 90)}` })));
      case "/model": {
        if (!arg) return print({ kind: "out", text: `  model: ${pref(MODEL_KEY, "sonnet")}` });
        if (!["opus", "sonnet", "haiku", "free"].includes(arg)) return print({ kind: "err", text: "Use opus, sonnet, haiku or free." });
        save(MODEL_KEY, arg);
        return print({ kind: "ok", text: `Model set to ${arg}.` });
      }
      case "/project": {
        const { projects } = await api<{ projects: ProjectConfig[] }>("/api/projects");
        if (!arg) return print({ kind: "out", text: `  project: ${pref(PROJECT_KEY, projects[0]?.name ?? "-")}   (${projects.map((p) => p.name).join(", ")})` });
        const p = projects.find((x) => x.name.toLowerCase() === arg.toLowerCase());
        if (!p) return print({ kind: "err", text: `No project "${arg}".` });
        save(PROJECT_KEY, p.name);
        return print({ kind: "ok", text: `Project set to ${p.name}.` });
      }
      case "/chat":
      case "/new": {
        if (!arg) return print({ kind: "err", text: `Usage: ${cmd} <${cmd === "/chat" ? "message" : "task"}>` });
        const model = pref(MODEL_KEY, "sonnet");
        const chat = cmd === "/chat";
        let project = NO_PROJECT;
        if (!chat) {
          const { projects } = await api<{ projects: ProjectConfig[] }>("/api/projects");
          project = projects.find((p) => p.name === pref(PROJECT_KEY, ""))?.name ?? projects[0]?.name ?? "";
          if (!project) return print({ kind: "err", text: "No projects yet." });
        }
        setBusy(true);
        try {
          const res = await api<{ id: string }>("/api/jobs", {
            project,
            task: arg,
            kind: chat ? "chat" : "team",
            chatModel: model,
            models: model === "free" ? "free" : model === "opus" ? "opus-sonnet" : model === "haiku" ? "sonnet-haiku" : "sonnet-haiku",
            autoMode: true,
          });
          refresh();
          setOpenId(res.id);
          setLines([]);
        } catch (e) {
          print({ kind: "err", text: (e as Error).message });
        } finally {
          setBusy(false);
        }
        return;
      }
      default: {
        // "/<skill> text" runs a skill in the open job.
        if (openId && expandSlash(text, skills) !== text) return send(openId, text);
        return print({ kind: "err", text: `Unknown command ${cmd}. /help lists them.` });
      }
    }
  }

  async function send(id: string, text: string) {
    const job = jobs.find((j) => j.id === id);
    try {
      await api(`/api/jobs/${id}/cmd`, { cmd: { type: "user_message", text: expandSlash(text, skills), agentId: job?.kind === "chat" ? CHAT_AGENT : "orchestrator" } });
    } catch (e) {
      print({ kind: "err", text: (e as Error).message });
    }
  }

  const working = agents.filter((a) => a.status === "running");
  const slash = input.startsWith("/") && !input.includes(" ") ? [...HELP.map(([c]) => c.split(" ")[0]!), ...skills.map((s) => `/${s.name}`)].filter((c) => c.startsWith(input)).slice(0, 6) : [];

  return (
    <div className="cli-term fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#1f1e1d] font-mono text-[14px] leading-[1.45] text-[#e8e6e3]" onClick={() => inputRef.current?.focus()}>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-3 sm:px-5">
        <div className="mb-3 inline-block max-w-full rounded-md border border-[#d97757] px-3 py-2">
          <div>
            <span className="text-[#d97757]">✻</span> Welcome to <span className="font-bold">wdash</span>!
          </div>
          <div className="mt-2 text-[#9b9a97]">/help for help, /exit to leave CLI mode</div>
          <div className="text-[#9b9a97]">
            pc: {state ? (state.home.online ? "online" : "offline") : "…"} · jobs: {jobs.length} · inbox: {state?.attention.length ?? 0}
          </div>
        </div>

        {openJob && (
          <div className="mb-2 text-[#9b9a97]">
            ── {openJob.title} · {openJob.project} · {openJob.status} · {usd(openJob.costUsd)} ── <span className="text-[#6b6a67]">(/back to close)</span>
          </div>
        )}
        {openId && <Transcript events={events} />}

        {lines.map((l, i) => (
          <div key={i} className={`whitespace-pre-wrap break-words ${l.kind === "in" ? "mt-2 text-[#9b9a97]" : l.kind === "err" ? "text-[#ff6b80]" : l.kind === "dim" ? "text-[#9b9a97]" : l.kind === "ok" ? "text-[#4eba65]" : ""}`}>
            {l.kind === "in" ? `> ${l.text}` : l.text}
          </div>
        ))}
        {(working.length > 0 || busy) && (
          <div className="mt-2 animate-pulse text-[#d97757]">✻ {busy ? "Starting…" : `Working… (${working.map((a) => a.id).join(", ")})`}</div>
        )}
        <div ref={bottom} className="h-2" />
      </div>

      <div className="px-3 pb-[calc(0.5rem+env(safe-area-inset-bottom))] sm:px-5">
        {slash.length > 0 && (
          <div className="mb-1 text-[#9b9a97]">
            {slash.map((c) => (
              <div key={c}>
                <span className="text-[#d97757]">{c}</span>
              </div>
            ))}
          </div>
        )}
        <form
          className="flex items-center gap-2 rounded-md border border-[#3d3d3a] px-3 py-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            const v = input;
            setInput("");
            void run(v);
          }}
        >
          <span className="text-[#9b9a97]">&gt;</span>
          <input
            ref={inputRef}
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-[#e8e6e3] caret-[#d97757] outline-none"
            value={input}
            spellCheck={false}
            autoComplete="off"
            aria-label="Command"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Tab" && slash.length) {
                e.preventDefault();
                setInput(`${slash[0]} `);
              } else if (e.key === "ArrowUp" && history.length) {
                e.preventDefault();
                const n = Math.min(hi + 1, history.length - 1);
                setHi(n);
                setInput(history[n]!);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                const n = hi - 1;
                setHi(Math.max(n, -1));
                setInput(n < 0 ? "" : history[n]!);
              } else if (e.key === "l" && e.ctrlKey) {
                e.preventDefault();
                setLines([]);
              }
            }}
          />
        </form>
        <div className="mt-1 flex justify-between text-[12px] text-[#6b6a67]">
          <span>{openJob ? `talking to ${openJob.kind === "chat" ? CHAT_AGENT : "orchestrator"}` : "? /help for shortcuts"}</span>
          <span>model: {typeof window === "undefined" ? "" : pref(MODEL_KEY, "sonnet")}</span>
        </div>
      </div>
    </div>
  );
}

function Transcript({ events }: { events: WdEvent[] }) {
  const results = new Map<string, WdEvent>();
  for (const e of events) if (e.type === "tool_result" && typeof e.payload.callId === "string") results.set(e.payload.callId, e);
  return (
    <>
      {events.map((e, i) => {
        const p = e.payload as Record<string, unknown>;
        if (e.subagentId) return null;
        if (e.type === "message") {
          const user = p.role === "user";
          return (
            <div key={i} className={`mt-2 whitespace-pre-wrap break-words ${user ? "bg-[#30302e] px-1 text-[#e8e6e3]" : ""}`}>
              <span className={user ? "text-[#9b9a97]" : ""}>{user ? "> " : "⏺ "}</span>
              {String(p.text ?? "")}
            </div>
          );
        }
        if (e.type === "tool_call") {
          if (p.tool === "AskUserQuestion") return null;
          const r = typeof p.callId === "string" ? results.get(p.callId) : undefined;
          const ok = r ? (r.payload.ok as boolean) : undefined;
          const out = String(r?.payload.output ?? "").replace(/\s+$/, "").split("\n");
          return (
            <div key={i} className="mt-2">
              <div className="break-words">
                <span className={ok === undefined ? "text-[#9b9a97]" : ok ? "text-[#4eba65]" : "text-[#ff6b80]"}>⏺ </span>
                <span className="font-bold">{String(p.tool)}</span>
                <span className="text-[#9b9a97]">({argOf(p.input)})</span>
              </div>
              {r && (
                <div className="whitespace-pre-wrap break-words text-[#9b9a97]">
                  {"  ⎿  "}
                  {out.slice(0, 3).join("\n     ") || "(no output)"}
                  {out.length > 3 && `\n     … +${out.length - 3} lines`}
                </div>
              )}
            </div>
          );
        }
        if (e.type === "question") return <div key={i} className="mt-2 text-[#ffc107]">? {String((p.questions as Array<{ question?: string }> | undefined)?.[0]?.question ?? "The agent has a question")} (answer by typing)</div>;
        if (e.type === "info" || e.type === "status") {
          const t = String(p.text ?? p.status ?? "");
          return t ? <div key={i} className="text-[#6b6a67]">  {t.slice(0, 200)}</div> : null;
        }
        return null;
      })}
    </>
  );
}

function argOf(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.skill ?? Object.values(o)[0];
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
}

function statusGlyph(j: JobRecord): string {
  return j.status === "running" ? "●" : j.status === "done" ? "✓" : j.status === "failed" ? "✗" : "○";
}

function pickJob(jobs: JobRecord[], arg: string): JobRecord | undefined {
  const n = Number(arg);
  if (Number.isInteger(n) && n >= 1) return jobs[n - 1];
  return jobs.find((j) => j.id === arg || j.id.endsWith(arg));
}

/** Live events and agents of one job (same endpoints as the job page). */
function useJobStream(id: string | undefined): { events: WdEvent[]; agents: AgentRecord[] } {
  const [events, setEvents] = useState<WdEvent[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const cursor = useRef("-");
  useEffect(() => {
    setEvents([]);
    setAgents([]);
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    cursor.current = "-";
    let tick = 0;
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
          if (tick++ % 2 === 0) {
            const d = await api<{ agents: AgentRecord[] }>(`/api/jobs/${id}`);
            if (!stop) setAgents(d.agents);
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
  return { events, agents };
}
