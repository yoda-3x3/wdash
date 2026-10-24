"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRecord, WdEvent } from "@wdash/shared";
import { api } from "@/lib/client";

type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
};

const SPEAK_KEY = "wdash:callSpeak";

/** Make agent replies sound like speech: no code, markdown, or links. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/**
 * Conference call with the whole team: what you say (typed or spoken) goes to the orchestrator and every
 * worker, finished ones included; their replies show here and can be read aloud, one voice per agent.
 */
export function Conference({ jobId, agents, events, onClose }: { jobId: string; agents: AgentRecord[]; events: WdEvent[]; onClose: () => void }) {
  const [since] = useState(() => Date.now());
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [err, setErr] = useState<string>();
  const rec = useRef<SpeechRec | undefined>(undefined);
  const spoken = useRef(new Set<string>());
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      setSpeak(localStorage.getItem(SPEAK_KEY) !== "0");
    } catch {
      /* storage blocked */
    }
  }, []);

  // What was said on this call: your conference messages and every agent's replies since you joined.
  const lines = useMemo(
    () =>
      events.filter(
        (e) =>
          e.type === "message" &&
          !e.subagentId &&
          e.ts >= since - 2000 &&
          (e.payload.role === "user" ? e.payload.conference === true : true),
      ),
    [events, since],
  );

  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [lines.length]);

  // Read new replies aloud, a different voice and pitch per agent.
  useEffect(() => {
    if (!speak || typeof speechSynthesis === "undefined") return;
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith(navigator.language.slice(0, 2)));
    for (const e of lines) {
      const key = e.id ?? `${e.ts}-${e.agentId}`;
      if (e.payload.role === "user" || spoken.current.has(key)) continue;
      spoken.current.add(key);
      const u = new SpeechSynthesisUtterance(`${e.agentId}: ${speakable(String(e.payload.text ?? ""))}`);
      const h = hash(e.agentId ?? "");
      if (voices.length) u.voice = voices[h % voices.length]!;
      u.pitch = 0.8 + (h % 5) * 0.12;
      u.rate = 1.05;
      speechSynthesis.speak(u);
    }
  }, [lines, speak]);

  useEffect(() => () => {
    rec.current?.stop();
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }, []);

  async function send(msg: string) {
    const t = msg.trim();
    if (!t) return;
    setBusy(true);
    setErr(undefined);
    try {
      await api(`/api/jobs/${jobId}/cmd`, { cmd: { type: "user_message", text: t, agentId: "*" } });
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function talk() {
    if (rec.current) return rec.current.stop();
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return setErr("This browser can't listen (try Chrome). You can still type.");
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); // don't talk over yourself
    const r = new Ctor();
    r.lang = navigator.language || "en-US";
    r.interimResults = true;
    r.continuous = false; // stops after a pause, then we send
    let said = "";
    r.onresult = (e) => {
      const results = (e as { results: ArrayLike<ArrayLike<{ transcript: string }>> }).results;
      said = "";
      for (let i = 0; i < results.length; i++) said += results[i]![0]!.transcript;
      setText(said);
    };
    r.onend = () => {
      rec.current = undefined;
      setListening(false);
      if (said.trim()) void send(said);
    };
    r.onerror = () => setErr("Microphone blocked or no speech heard.");
    rec.current = r;
    setListening(true);
    r.start();
  }

  const team = agents.filter((a) => a.role !== "chat" || agents.length === 1);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-bg/70 p-2 backdrop-blur-sm sm:items-center" role="dialog" aria-label="Conference call">
      <div className="card flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <span className="font-medium">📞 Conference call</span>
          <span className="flex flex-wrap gap-1">
            <span className="chip bg-panel-2">you</span>
            {team.map((a) => (
              <span key={a.id} className="chip bg-panel-2" title={a.status}>
                <span className={`h-1.5 w-1.5 rounded-full ${["running", "starting", "reviewing"].includes(a.status) ? "animate-pulse bg-ok" : a.status === "done" ? "bg-muted" : "bg-info"}`} />
                {a.id}
              </span>
            ))}
          </span>
          <label className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted">
            <input
              type="checkbox"
              checked={speak}
              onChange={(e) => {
                setSpeak(e.target.checked);
                if (!e.target.checked && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
                try {
                  localStorage.setItem(SPEAK_KEY, e.target.checked ? "1" : "0");
                } catch {
                  /* ignore */
                }
              }}
            />
            read aloud
          </label>
          <button className="btn py-1 text-xs" onClick={onClose}>
            Hang up
          </button>
        </div>
        <div className="min-h-40 flex-1 space-y-2 overflow-y-auto p-3 text-sm">
          {lines.length === 0 && <p className="text-muted">You're on with the whole team. Say something; finished workers wake up to answer.</p>}
          {lines.map((e, i) => (
            <div key={e.id ?? i} className={e.payload.role === "user" ? "ml-10 rounded-lg bg-accent/10 px-3 py-2" : "mr-10 rounded-lg bg-panel-2 px-3 py-2"}>
              <div className="text-[11px] text-muted">{e.payload.role === "user" ? "you → everyone" : e.agentId}</div>
              <div className="whitespace-pre-wrap break-words">{String(e.payload.text ?? "")}</div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form
          className="flex items-center gap-2 border-t border-line p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <button
            type="button"
            onClick={talk}
            className={`btn shrink-0 px-3 ${listening ? "animate-pulse border-bad text-bad" : ""}`}
            aria-label={listening ? "Stop talking" : "Talk"}
            title="Tap, talk, pause: it sends"
          >
            🎤
          </button>
          <input className="input" placeholder={listening ? "Listening…" : "Talk or type to everyone…"} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary shrink-0" disabled={busy || !text.trim()}>
            Send
          </button>
        </form>
        {err && <p className="px-3 pb-2 text-xs text-bad">{err}</p>}
      </div>
    </div>
  );
}
