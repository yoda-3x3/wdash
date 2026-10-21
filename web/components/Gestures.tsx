"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Attention } from "@wdash/shared";
import { api } from "@/lib/client";
import { GestureTracker, LEGEND, POSE_EMOJI, classify, type GestureAction, type Pose } from "@/lib/gestures";
import { swipeTo } from "@/lib/swipe";
import { useBoard } from "./Shell";

const PREF = "wdash:gestures";
const FRAME_MS = 66; // ~15 fps is plenty for hands and keeps phones cool
const SCROLL_PX = 22;

type Recognizer = {
  recognizeForVideo: (v: HTMLVideoElement, t: number) => { gestures: Array<Array<{ categoryName: string; score: number }>>; landmarks: Array<Array<{ x: number; y: number }>> };
  close: () => void;
};

type SpeechRec = { lang: string; interimResults: boolean; continuous: boolean; start: () => void; stop: () => void; onresult: ((e: unknown) => void) | null; onend: (() => void) | null; onerror: ((e: unknown) => void) | null };

/** Header toggle + camera overlay. Video never leaves the device: MediaPipe runs in the page. */
export function Gestures() {
  const [on, setOn] = useState(false);
  const [status, setStatus] = useState<"off" | "loading" | "ready" | "error">("off");
  const [err, setErr] = useState<string>();

  useEffect(() => {
    try {
      if (localStorage.getItem(PREF) === "1") setOn(true);
    } catch {
      /* storage blocked */
    }
  }, []);

  const toggle = () => {
    const next = !on;
    setOn(next);
    setErr(undefined);
    try {
      localStorage.setItem(PREF, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={toggle}
        className={`chip shrink-0 border ${on ? "border-accent bg-accent/15 text-accent" : "border-line text-muted"}`}
        title={on ? "Turn off camera gestures" : "Control wdash with hand gestures (camera stays on this device)"}
        aria-pressed={on}
      >
        📷<span className="hidden sm:inline">{on ? (status === "loading" ? "Loading…" : "Gestures on") : "Gestures"}</span>
      </button>
      {on && <Camera onStatus={setStatus} onError={(m) => (setErr(m), setStatus("error"))} onClose={toggle} />}
      {on && err && (
        <div className="fixed right-4 top-[calc(3.75rem+env(safe-area-inset-top))] z-30 max-w-xs rounded-lg border border-bad/50 bg-panel p-3 text-xs text-bad shadow-lg">
          Gestures: {err}
          <button className="ml-2 underline" onClick={toggle}>
            Turn off
          </button>
        </div>
      )}
    </>
  );
}

function Camera({ onStatus, onError, onClose }: { onStatus: (s: "loading" | "ready") => void; onError: (m: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const router = useRouter();
  const path = usePathname();
  const { state, refresh } = useBoard();
  const [pose, setPose] = useState<Pose>("none");
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<string>();
  const [legend, setLegend] = useState(false);
  const [listening, setListening] = useState(false);
  // Paused: the camera keeps watching, but only 🤙 (to resume) does anything.
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const setPause = useCallback((p: boolean) => {
    pausedRef.current = p;
    setPaused(p);
  }, []);
  const speech = useRef<SpeechRec | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const cb = useRef({ onStatus, onError });
  cb.current = { onStatus, onError };

  // Latest values for the frame loop without restarting the camera on every render.
  const ctx = useRef({ path, state, refresh, router });
  ctx.current = { path, state, refresh, router };

  const say = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 2500);
  }, []);

  const run = useCallback(
    async (a: GestureAction) => {
      const { path, refresh, router } = ctx.current;
      const jobId = path.startsWith("/jobs/") ? path.split("/")[2] : undefined;
      if (a === "toggle_pause") {
        setPause(!pausedRef.current);
        say(pausedRef.current ? "🤙 Paused. 🤙 again to resume" : "🤙 Gestures resumed");
        return;
      }
      if (pausedRef.current) return;
      switch (a) {
        case "scroll_up":
        case "scroll_down":
          window.scrollBy({ top: a === "scroll_up" ? -SCROLL_PX : SCROLL_PX });
          return;
        case "board":
          if (path !== "/") router.push("/");
          say("✋ Board");
          return;
        case "prev_page":
        case "next_page": {
          const label = await swipeTo(router.push, path, a === "next_page" ? "next" : "prev");
          say(`${a === "next_page" ? "👉" : "👈"} ${label}`);
          return;
        }
        case "approve":
        case "deny": {
          const s = await api<{ attention: Attention[] }>("/api/state").catch(() => undefined);
          const perms = (s?.attention ?? []).filter((x) => x.reason === "permission" && x.ref).sort((x, y) => x.createdAt - y.createdAt);
          const target = perms.find((x) => x.jobId === jobId) ?? perms[0];
          if (!target) return say(a === "approve" ? "👍 Nothing waiting for approval" : "👎 Nothing to deny");
          try {
            await api(`/api/jobs/${target.jobId}/cmd`, { cmd: { type: "decide", requestId: target.ref, allow: a === "approve", scope: "once" } });
            say(`${a === "approve" ? "👍 Allowed" : "👎 Denied"}: ${(target.body ?? target.title).slice(0, 60)}`);
            refresh();
          } catch (e) {
            say(`Couldn't ${a}: ${(e as Error).message}`);
          }
          return;
        }
        case "open_1":
        case "open_2":
        case "open_3":
        case "open_4":
        case "open_5": {
          const n = a.slice(5);
          const tile = document.querySelector<HTMLElement>(`[data-wall-tile="${n}"]`);
          const href = tile?.dataset.href;
          if (!tile || !href) return say(`No tile ${n} on the Wall`);
          tile.animate([{ outline: "3px solid #a5b4fc", transform: "scale(1)" }, { outline: "3px solid #a5b4fc", transform: "scale(1.03)" }, { outline: "3px solid transparent", transform: "scale(1)" }], { duration: 350 });
          say(`${n}️⃣ ${tile.dataset.label ?? "Opening"}`);
          setTimeout(() => router.push(href), 250);
          return;
        }
        case "dictate":
          return startDictation();
        case "send":
          if (speech.current) {
            speech.current.stop();
            // Let the final transcript land before sending.
            setTimeout(() => clickSend(), 400);
          } else clickSend();
          return;
      }

      function clickSend() {
        const btn = document.querySelector<HTMLButtonElement>("[data-chat-send]");
        if (!btn) return say("✊ No chat box on this page");
        if (btn.disabled) return say("✊ Nothing to send");
        btn.click();
        say("✊ Sent");
      }

      function startDictation() {
        const input = document.querySelector<HTMLInputElement>("[data-chat-input]");
        if (!input) return say("🤟 Open a job or chat to dictate");
        const W = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
        const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
        if (!Ctor) return say("🤟 This browser can't do voice dictation (try Chrome)");
        if (speech.current) return;
        const rec = new Ctor();
        rec.lang = navigator.language || "en-US";
        rec.interimResults = true;
        rec.continuous = true;
        const before = input.value ? `${input.value} ` : "";
        rec.onresult = (e) => {
          const results = (e as { results: ArrayLike<ArrayLike<{ transcript: string }>> }).results;
          let text = "";
          for (let i = 0; i < results.length; i++) text += results[i]![0]!.transcript;
          setReactInput(input, before + text.trim());
        };
        rec.onend = () => {
          speech.current = undefined;
          setListening(false);
        };
        rec.onerror = () => say("🎤 Dictation stopped (microphone blocked?)");
        speech.current = rec;
        setListening(true);
        input.focus();
        rec.start();
        say("🎤 Listening… make a fist to send");
      }
    },
    [say, setPause],
  );

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | undefined;
    let recognizer: Recognizer | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tracker = new GestureTracker();

    const onStatus = (st: "loading" | "ready") => cb.current.onStatus(st);
    const onError = (m: string) => cb.current.onError(m);
    (async () => {
      onStatus("loading");
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } }, audio: false });
      } catch (e) {
        return onError((e as Error).name === "NotAllowedError" ? "camera permission was denied." : `no camera (${(e as Error).message}).`);
      }
      if (stop) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      try {
        // Loaded on demand and served from this site (CDNs are often blocked on school networks).
        const { FilesetResolver, GestureRecognizer } = await import("@mediapipe/tasks-vision");
        const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        const make = (delegate: "GPU" | "CPU") =>
          GestureRecognizer.createFromOptions(files, {
            baseOptions: { modelAssetPath: "/mediapipe/gesture_recognizer.task", delegate },
            runningMode: "VIDEO",
            numHands: 1,
          });
        recognizer = (await make("GPU").catch(() => make("CPU"))) as unknown as Recognizer;
      } catch (e) {
        return onError(`couldn't load the hand model (${(e as Error).message}).`);
      }
      if (stop) return recognizer.close();
      onStatus("ready");

      let last = -1;
      const loop = () => {
        if (stop) return;
        const now = performance.now();
        if (v.readyState >= 2 && v.currentTime !== last) {
          last = v.currentTime;
          const r = recognizer!.recognizeForVideo(v, now);
          const c = classify(r.gestures, r.landmarks, { countFingers: ctx.current.path === "/wall" });
          for (const a of tracker.update(c.pose, c.wrist, now)) void run(a);
          setPose(tracker.current);
          setProgress(pausedRef.current && tracker.current !== "shaka" ? 0 : tracker.progress(now));
        }
        timer = setTimeout(loop, FRAME_MS);
      };
      loop();
    })();

    return () => {
      stop = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      recognizer?.close();
      speech.current?.stop();
    };
  }, [run]);

  return (
    <div className="fixed right-4 top-[calc(3.75rem+env(safe-area-inset-top))] z-30 flex flex-row-reverse items-start gap-2">
      <div className="relative">
        <video
          ref={video}
          muted
          playsInline
          className={`h-24 w-32 -scale-x-100 rounded-lg border bg-black object-cover shadow-lg ${paused ? "border-warn opacity-50" : "border-line"}`}
        />
        {paused && <div className="absolute inset-0 flex items-center justify-center text-2xl" aria-label="Gestures paused">⏸</div>}
        <div className="absolute bottom-1 left-1 flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-sm text-white">
          <span>{POSE_EMOJI[pose]}</span>
          {progress > 0 && (
            <span className="h-1 w-8 overflow-hidden rounded bg-white/30">
              <span className="block h-full bg-white" style={{ width: `${progress * 100}%` }} />
            </span>
          )}
          {listening && <span className="animate-pulse">🎤</span>}
        </div>
        <div className="absolute right-1 top-1 flex gap-1">
          <button
            type="button"
            className="rounded bg-black/60 px-1.5 text-xs text-white"
            onClick={() => {
              setPause(!paused);
              say(paused ? "Gestures resumed" : "Paused. 🤙 or ▶ to resume");
            }}
            aria-label={paused ? "Resume gestures" : "Pause gestures"}
            title={paused ? "Resume" : "Pause (or hold 🤙)"}
          >
            {paused ? "▶" : "⏸"}
          </button>
          <button type="button" className="rounded bg-black/60 px-1.5 text-xs text-white" onClick={() => setLegend((v) => !v)} aria-label="Gesture help">
            ?
          </button>
          <button type="button" className="rounded bg-black/60 px-1.5 text-xs text-white" onClick={onClose} aria-label="Turn off gestures" title="Turn off the camera">
            ✕
          </button>
        </div>
      </div>
      {legend && (
        <div className="card max-w-xs space-y-1 p-3 text-xs shadow-lg">
          <div className="font-medium">Gestures</div>
          {LEGEND.map(([g, what]) => (
            <div key={g} className="flex gap-2">
              <span className="w-24 shrink-0">{g}</span>
              <span className="text-muted">{what}</span>
            </div>
          ))}
          <p className="pt-1 text-muted">Video stays on this device.</p>
        </div>
      )}
      {toast && <div className="rounded-lg bg-panel px-3 py-2 text-sm shadow-lg ring-1 ring-line">{toast}</div>}
    </div>
  );
}

/** Set a React-controlled input's value so its onChange fires. */
function setReactInput(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}
