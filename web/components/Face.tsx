"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { decideNext, jobIdFromPath } from "@/lib/decide";
import { FACE_EMOJI, FACE_LEGEND, FaceTracker, headPose, type Blend, type FacePose } from "@/lib/face";
import type { GestureAction } from "@/lib/gestures";
import { onListening, sendChat, startDictation, stopDictation } from "@/lib/handsfree";
import { swipeTo } from "@/lib/swipe";
import { useBoard } from "./Shell";

const PREF = "wdash:face";
const FRAME_MS = 50;
const SCROLL_PX = 22;

type Landmarker = {
  detectForVideo: (v: HTMLVideoElement, t: number) => {
    faceLandmarks: Array<Array<{ x: number; y: number }>>;
    faceBlendshapes: Array<{ categories: Array<{ categoryName: string; score: number }> }>;
  };
  close: () => void;
};

/** Header toggle for face-gesture control: head turns/tilts and expressions (camera stays on this device). */
export function Face() {
  const [on, setOn] = useState(false);
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
        title={on ? "Turn off face control" : "Control wdash with head turns and expressions (camera stays on this device)"}
        aria-pressed={on}
      >
        🙂<span className="hidden sm:inline">{on ? "Face on" : "Face"}</span>
      </button>
      {on && <FaceControl onClose={toggle} />}
    </>
  );
}

function FaceControl({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const router = useRouter();
  const path = usePathname();
  const { refresh } = useBoard();
  const [status, setStatus] = useState<"loading" | "learning" | "ready" | "error">("loading");
  const [err, setErr] = useState<string>();
  const [pose, setPose] = useState<FacePose>("none");
  const [progress, setProgress] = useState(0);
  const [toast, setToast] = useState<string>();
  const [legend, setLegend] = useState(false);
  const [paused, setPaused] = useState(false);
  const [listening, setListening] = useState(false);
  const pausedRef = useRef(false);
  const ctx = useRef({ path, refresh, router });
  ctx.current = { path, refresh, router };
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => onListening(setListening), []);

  const say = useCallback((t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 2500);
  }, []);

  const run = useCallback(
    async (a: GestureAction) => {
      if (pausedRef.current) return;
      const { path, refresh, router } = ctx.current;
      switch (a) {
        case "scroll_up":
        case "scroll_down":
          window.scrollBy({ top: a === "scroll_up" ? -SCROLL_PX : SCROLL_PX });
          return;
        case "next_page":
        case "prev_page":
          say(`${a === "next_page" ? "➡️" : "⬅️"} ${await swipeTo(router.push, path, a === "next_page" ? "next" : "prev")}`);
          return;
        case "approve":
        case "deny":
          say(`😉 ${await decideNext(a === "approve", jobIdFromPath(path))}`);
          refresh();
          return;
        case "board":
          if (path !== "/") router.push("/");
          say("🤨 Board");
          return;
        case "dictate":
          say(`😮 ${startDictation("smile")}`);
          return;
        case "send":
          say(`😄 ${await sendChat()}`);
          return;
      }
    },
    [say],
  );

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | undefined;
    let lm: Landmarker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const tracker = new FaceTracker();

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 320 }, height: { ideal: 240 } }, audio: false });
      } catch (e) {
        setErr((e as Error).name === "NotAllowedError" ? "camera permission was denied." : `no camera (${(e as Error).message}).`);
        return setStatus("error");
      }
      if (stop) return stream.getTracks().forEach((t) => t.stop());
      const v = video.current!;
      v.srcObject = stream;
      await v.play().catch(() => undefined);
      try {
        const { FilesetResolver, FaceLandmarker } = await import("@mediapipe/tasks-vision");
        const files = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
        const make = (delegate: "GPU" | "CPU") =>
          FaceLandmarker.createFromOptions(files, {
            baseOptions: { modelAssetPath: "/mediapipe/face_landmarker.task", delegate },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: true,
          });
        lm = (await make("GPU").catch(() => make("CPU"))) as unknown as Landmarker;
      } catch (e) {
        setErr(`couldn't load the face model (${(e as Error).message}).`);
        return setStatus("error");
      }
      if (stop) return lm.close();
      setStatus("learning");

      let last = -1;
      const loop = () => {
        if (stop) return;
        const now = performance.now();
        if (v.readyState >= 2 && v.currentTime !== last) {
          last = v.currentTime;
          const r = lm!.detectForVideo(v, now);
          const face = r.faceLandmarks[0];
          const blend: Blend = {};
          for (const c of r.faceBlendshapes[0]?.categories ?? []) blend[c.categoryName] = c.score;
          for (const a of tracker.update(face ? headPose(face) : undefined, blend, now)) void run(a);
          if (tracker.ready) setStatus((s) => (s === "learning" ? "ready" : s));
          setPose(tracker.current);
          setProgress(tracker.progress(now));
        }
        timer = setTimeout(loop, FRAME_MS);
      };
      loop();
    })();

    return () => {
      stop = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      lm?.close();
      stopDictation();
    };
  }, [run]);

  const message =
    status === "loading"
      ? "Loading face control…"
      : status === "learning"
        ? "Look at the screen normally for a second…"
        : status === "error"
          ? err
          : paused
            ? "Paused"
            : (toast ?? "Turn head to switch pages · tilt to scroll · wink to allow/deny");
  return (
    <>
      <video ref={video} muted playsInline className="hidden" />
      <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2">
        {legend && (
          <div className="card space-y-1 p-3 text-xs shadow-lg">
            {FACE_LEGEND.map(([g, what]) => (
              <div key={g} className="flex gap-2">
                <span className="w-32 shrink-0">{g}</span>
                <span className="text-muted">{what}</span>
              </div>
            ))}
            <p className="pt-1 text-muted">Video stays on this device.</p>
          </div>
        )}
        <div className="flex items-center gap-2 rounded-full bg-panel px-3 py-1.5 text-xs shadow-lg ring-1 ring-line">
          <span className="text-base">{FACE_EMOJI[pose]}</span>
          {progress > 0 && !paused && (
            <span className="h-1 w-8 overflow-hidden rounded bg-line">
              <span className="block h-full bg-accent" style={{ width: `${progress * 100}%` }} />
            </span>
          )}
          {listening && <span className="animate-pulse">🎤</span>}
          <span className="truncate">{message}</span>
          {status === "ready" && (
            <button
              className="text-accent"
              onClick={() => {
                pausedRef.current = !paused;
                setPaused(!paused);
              }}
              aria-label={paused ? "Resume face control" : "Pause face control"}
            >
              {paused ? "▶" : "⏸"}
            </button>
          )}
          <button className="text-muted" onClick={() => setLegend((v) => !v)} aria-label="Face gesture help">
            ?
          </button>
          <button className="text-muted" onClick={onClose} aria-label="Turn off face control">
            ✕
          </button>
        </div>
      </div>
    </>
  );
}
