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
/** Without read-aloud, a blob "talks" this long after its reply arrives. */
const QUIET_TALK_MS = 3500;

/** Make agent replies sound like speech: no code, markdown, or links. */
function speakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " (code) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const colorFor = (id: string) => (id === "orchestrator" || id === "claude" ? "var(--accent)" : `hsl(${hash(id) % 360} 85% 62%)`);
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Conference call with the whole team: what you say (spoken or typed) goes to the orchestrator and every
 * worker, finished ones included. Each AI is a blob that talks (ripples) while its reply is read aloud,
 * breathes while it works, and shows its latest words as a caption.
 */
export function Conference({ jobId, agents, events, onClose }: { jobId: string; agents: AgentRecord[]; events: WdEvent[]; onClose: () => void }) {
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [text, setText] = useState("");
  const [typing, setTyping] = useState(false);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(true);
  const [talking, setTalking] = useState<string>();
  const [err, setErr] = useState<string>();
  const rec = useRef<SpeechRec | undefined>(undefined);
  const spoken = useRef(new Set<string>());

  useEffect(() => {
    try {
      setSpeak(localStorage.getItem(SPEAK_KEY) !== "0");
    } catch {
      /* storage blocked */
    }
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  // What was said on this call: your conference messages and every agent's replies since you joined.
  const lines = useMemo(
    () => events.filter((e) => e.type === "message" && !e.subagentId && e.ts >= since - 2000 && (e.payload.role === "user" ? e.payload.conference === true : true)),
    [events, since],
  );
  const latest = useMemo(() => {
    const m = new Map<string, WdEvent>();
    for (const e of lines) if (e.payload.role !== "user" && e.agentId) m.set(e.agentId, e);
    return m;
  }, [lines]);

  // Read new replies aloud (one voice/pitch per agent); the speaking agent's blob talks.
  useEffect(() => {
    if (!speak || typeof speechSynthesis === "undefined") return;
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.startsWith(navigator.language.slice(0, 2)));
    for (const e of lines) {
      const key = e.id ?? `${e.ts}-${e.agentId}`;
      if (e.payload.role === "user" || spoken.current.has(key)) continue;
      spoken.current.add(key);
      const who = e.agentId ?? "";
      const u = new SpeechSynthesisUtterance(speakable(String(e.payload.text ?? "")));
      const h = hash(who);
      if (voices.length) u.voice = voices[h % voices.length]!;
      u.pitch = 0.8 + (h % 5) * 0.12;
      u.rate = 1.05;
      u.onstart = () => setTalking(who);
      u.onend = () => setTalking((t) => (t === who ? undefined : t));
      speechSynthesis.speak(u);
    }
  }, [lines, speak]);

  useEffect(
    () => () => {
      rec.current?.stop();
      if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
    },
    [],
  );

  const isTalking = (id: string) => {
    if (speak) return talking === id;
    const last = latest.get(id);
    return !!last && now - last.ts < QUIET_TALK_MS;
  };

  async function send(msg: string) {
    const t = msg.trim();
    if (!t) return;
    setErr(undefined);
    try {
      await api(`/api/jobs/${jobId}/cmd`, { cmd: { type: "user_message", text: t, agentId: "*" } });
      setText("");
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  function talk() {
    if (rec.current) return rec.current.stop();
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) {
      setTyping(true);
      return setErr("This browser can't listen (try Chrome). Type instead.");
    }
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel(); // don't talk over yourself
    setTalking(undefined);
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
    setErr(undefined);
    r.start();
  }

  const team = agents.filter((a) => a.role !== "chat" || agents.length === 1);
  const myLast = [...lines].reverse().find((e) => e.payload.role === "user");
  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg" role="dialog" aria-label="Conference call">
      <div className="flex items-center justify-center gap-3 px-4 pb-2 pt-[calc(1rem+env(safe-area-inset-top))] text-sm text-muted">
        <span className="h-2 w-2 animate-pulse rounded-full bg-ok" />
        Conference · {team.length + 1} on the call · {clock(now - since)}
      </div>

      <div className="flex flex-1 flex-wrap content-center items-start justify-center gap-x-8 gap-y-10 overflow-y-auto px-4 py-6">
        <Participant
          id="you"
          color="var(--fg)"
          state={listening ? "talking" : "idle"}
          caption={listening ? text || "listening…" : myLast ? String(myLast.payload.text ?? "") : "tap 🎤 to talk"}
        />
        {team.map((a) => (
          <Participant
            key={a.id}
            id={a.id}
            color={colorFor(a.id)}
            state={isTalking(a.id) ? "talking" : ["running", "starting", "reviewing"].includes(a.status) ? "working" : "idle"}
            caption={latest.get(a.id) ? speakable(String(latest.get(a.id)!.payload.text ?? "")) : a.status === "done" ? "finished · wakes up when you talk" : a.status}
          />
        ))}
      </div>

      {typing && (
        <form
          className="mx-auto flex w-full max-w-xl gap-2 px-4 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <input autoFocus className="input" placeholder="Type to everyone…" value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary shrink-0" disabled={!text.trim()}>
            Send
          </button>
        </form>
      )}
      {err && <p className="px-4 pb-1 text-center text-xs text-bad">{err}</p>}

      <div className="flex items-center justify-center gap-4 px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-2">
        <RoundButton
          label={speak ? "Speaker on" : "Speaker off"}
          onClick={() => {
            const v = !speak;
            setSpeak(v);
            if (!v && typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
            setTalking(undefined);
            try {
              localStorage.setItem(SPEAK_KEY, v ? "1" : "0");
            } catch {
              /* ignore */
            }
          }}
        >
          {speak ? "🔊" : "🔇"}
        </RoundButton>
        <button
          type="button"
          onClick={talk}
          aria-label={listening ? "Stop talking" : "Talk"}
          className={`flex h-16 w-16 items-center justify-center rounded-full text-2xl shadow-lg transition ${listening ? "scale-110 bg-ok text-bg ring-4 ring-ok/40" : "bg-panel-2 ring-1 ring-line"}`}
        >
          🎤
        </button>
        <RoundButton label="Type" onClick={() => setTyping((v) => !v)}>
          ⌨️
        </RoundButton>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hang up"
          className="flex h-12 w-12 items-center justify-center rounded-full bg-bad text-xl text-white shadow-lg"
          title="Hang up"
        >
          📞
        </button>
      </div>
    </div>
  );
}

function Participant({ id, color, state, caption }: { id: string; color: string; state: "talking" | "working" | "idle"; caption: string }) {
  return (
    <div className="flex w-36 flex-col items-center gap-2 text-center">
      <div className="relative flex h-24 w-24 items-center justify-center" style={{ ["--blob" as string]: color }}>
        {state === "talking" && (
          <>
            <span className="blob-ring absolute inset-0" />
            <span className="blob-ring absolute inset-0" style={{ animationDelay: "0.8s" }} />
          </>
        )}
        <span className={`blob absolute inset-1 ${state === "talking" ? "blob-talking" : state === "working" ? "blob-working" : "blob-idle"}`} />
      </div>
      <div className="text-sm font-medium">{id}</div>
      <div className="line-clamp-3 min-h-[3em] text-xs text-muted">{caption}</div>
    </div>
  );
}

function RoundButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="flex h-12 w-12 items-center justify-center rounded-full bg-panel-2 text-xl ring-1 ring-line">
      {children}
    </button>
  );
}
