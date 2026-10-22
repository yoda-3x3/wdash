"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { decideNext, jobIdFromPath } from "@/lib/decide";
import { BlinkTracker, CALIBRATION_POINTS, Smoother, fitGaze, gazeFeatures, predictGaze, scrollFor, type Blend, type GazeModel } from "@/lib/eyes";
import { useBoard } from "./Shell";

const PREF = "wdash:eyes";
const MODEL_KEY = "wdash:gazeModel";
const FRAME_MS = 50;
const SETTLE_MS = 700; // per calibration dot: time to look at it…
const SAMPLE_MS = 900; // …then time to collect samples

type Landmarker = {
  detectForVideo: (v: HTMLVideoElement, t: number) => {
    faceLandmarks: Array<Array<{ x: number; y: number }>>;
    faceBlendshapes: Array<{ categories: Array<{ categoryName: string; score: number }> }>;
  };
  close: () => void;
};

/** A calibration is only valid for the window size it was made at. */
type Saved = { model: GazeModel; w: number; h: number };

function loadModel(): GazeModel | undefined {
  try {
    const s = JSON.parse(localStorage.getItem(MODEL_KEY) ?? "null") as Saved | null;
    if (s && Math.abs(s.w - innerWidth) < 80 && Math.abs(s.h - innerHeight) < 80) return s.model;
  } catch {
    /* none or blocked */
  }
  return undefined;
}

/** Header toggle for webcam eye tracking: gaze mouse, long-blink click, look-to-scroll, winks. */
export function Eyes() {
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
        title={on ? "Turn off eye tracking" : "Eye tracking: look to point, long blink to click (camera stays on this device)"}
        aria-pressed={on}
      >
        👁<span className="hidden sm:inline">{on ? "Eyes on" : "Eyes"}</span>
      </button>
      {on && <Tracker onClose={toggle} />}
    </>
  );
}

function Tracker({ onClose }: { onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const router = useRouter();
  const path = usePathname();
  const { refresh } = useBoard();
  const [status, setStatus] = useState<"loading" | "calibrating" | "ready" | "error">("loading");
  const [err, setErr] = useState<string>();
  const [calIndex, setCalIndex] = useState(-1);
  const [dot, setDot] = useState<{ x: number; y: number }>();
  const [box, setBox] = useState<DOMRect>();
  const [ring, setRing] = useState(0);
  const [toast, setToast] = useState<string>();
  const model = useRef<GazeModel | undefined>(undefined);
  const calibrate = useRef<() => void>(() => undefined);
  const ctx = useRef({ path, refresh, router });
  ctx.current = { path, refresh, router };
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const say = useCallback((t: string) => {
    setToast(t);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(undefined), 2500);
  }, []);

  useEffect(() => {
    let stop = false;
    let stream: MediaStream | undefined;
    let lm: Landmarker | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const smooth = new Smoother();
    const blinks = new BlinkTracker();
    // Calibration state, driven from the frame loop.
    let cal: { i: number; start: number; samples: Array<[number[], { x: number; y: number }]> } | undefined;

    const target = (x: number, y: number): { el?: HTMLElement; tile?: HTMLElement } => {
      const at = document.elementFromPoint(x, y) as HTMLElement | null;
      const tile = at?.closest<HTMLElement>("[data-wall-tile], section[data-href]") ?? undefined;
      const el = tile ?? at?.closest<HTMLElement>("a, button, [role=tab], select, input, textarea, summary") ?? undefined;
      return { el, tile };
    };

    calibrate.current = () => {
      cal = { i: 0, start: performance.now(), samples: [] };
      setCalIndex(0);
      setStatus("calibrating");
      setDot(undefined);
      setBox(undefined);
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
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
      model.current = loadModel();
      if (model.current) setStatus("ready");
      else calibrate.current();

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
          const f = face ? gazeFeatures(face, blend) : undefined;

          if (cal) {
            // Collect while the dot is shown and the eyes are open.
            const t = now - cal.start;
            const p = CALIBRATION_POINTS[cal.i]!;
            if (f && t > SETTLE_MS && (blend.eyeBlinkLeft ?? 0) < 0.4 && (blend.eyeBlinkRight ?? 0) < 0.4) cal.samples.push([f, p]);
            if (t > SETTLE_MS + SAMPLE_MS) {
              cal.i++;
              cal.start = now;
              if (cal.i < CALIBRATION_POINTS.length) setCalIndex(cal.i);
              else {
                try {
                  model.current = fitGaze(cal.samples);
                  localStorage.setItem(MODEL_KEY, JSON.stringify({ model: model.current, w: innerWidth, h: innerHeight } satisfies Saved));
                  setStatus("ready");
                  say("👁 Calibrated. Long blink to click, wink to approve/deny");
                } catch {
                  say("👁 Couldn't see your eyes well enough. Try again in better light");
                  setStatus("ready");
                }
                cal = undefined;
                setCalIndex(-1);
              }
            }
          } else if (f && model.current) {
            const g = smooth.next(predictGaze(model.current, f));
            const x = g.x * innerWidth;
            const y = g.y * innerHeight;
            setDot({ x, y });
            const { el, tile } = target(x, y);
            setBox(el?.getBoundingClientRect());
            const dy = scrollFor(g.y);
            if (dy) window.scrollBy({ top: dy });
            setRing(blinks.progress(now));
            for (const ev of blinks.update(blend, now)) {
              const { path, refresh, router } = ctx.current;
              if (ev === "click") {
                if (tile?.dataset.href) {
                  say(`👁 Opening ${tile.dataset.label ?? "tile"}`);
                  router.push(tile.dataset.href);
                } else if (el) {
                  el.focus?.();
                  el.click();
                  say(`👁 Clicked ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30) || "it"}`);
                }
              } else {
                const allow = ev === "wink_left";
                void decideNext(allow, jobIdFromPath(path)).then((m) => {
                  say(`😉 ${m}`);
                  refresh();
                });
              }
            }
          } else {
            setDot(undefined);
            setBox(undefined);
          }
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
    };
  }, [say]);

  const calPoint = calIndex >= 0 ? CALIBRATION_POINTS[calIndex] : undefined;
  return (
    <>
      <video ref={video} muted playsInline className="hidden" />
      {status === "calibrating" && (
        <div className="fixed inset-0 z-50 bg-bg/95">
          <p className="absolute left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 text-center text-sm text-muted">
            Keep your head still and look at each dot until it moves ({calIndex + 1}/{CALIBRATION_POINTS.length}).
          </p>
          {calPoint && (
            <span
              className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 animate-pulse rounded-full bg-accent ring-4 ring-accent/30"
              style={{ left: `${calPoint.x * 100}%`, top: `${calPoint.y * 100}%` }}
            />
          )}
          <button className="btn absolute bottom-6 left-1/2 -translate-x-1/2" onClick={onClose}>
            Cancel
          </button>
        </div>
      )}
      {box && status === "ready" && (
        <div
          className="pointer-events-none fixed z-40 rounded-md ring-2 ring-accent/70 transition-all duration-100"
          style={{ left: box.left - 3, top: box.top - 3, width: box.width + 6, height: box.height + 6 }}
        />
      )}
      {dot && status === "ready" && (
        <div
          className="pointer-events-none fixed z-50 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent bg-accent/30"
          style={{ left: dot.x, top: dot.y, boxShadow: ring ? `0 0 0 ${2 + ring * 6}px rgb(99 102 241 / ${0.25 + ring * 0.5})` : undefined }}
        />
      )}
      {(status === "ready" || status === "loading" || status === "error") && (
        <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] left-1/2 z-40 flex -translate-x-1/2 items-center gap-2 rounded-full bg-panel px-3 py-1.5 text-xs shadow-lg ring-1 ring-line">
          <span>{status === "loading" ? "👁 Loading eye tracking…" : status === "error" ? `👁 ${err}` : (toast ?? "👁 Look to point · long blink = click · wink L/R = allow/deny")}</span>
          {status === "ready" && (
            <button className="text-accent" onClick={() => calibrate.current()}>
              Recalibrate
            </button>
          )}
          <button className="text-muted" onClick={onClose} aria-label="Turn off eye tracking">
            ✕
          </button>
        </div>
      )}
    </>
  );
}
