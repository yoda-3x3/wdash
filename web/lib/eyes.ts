// Webcam eye tracking from MediaPipe Face Landmarker output. Pure, so it runs per video frame and can be tested.
//
// Gaze: iris position inside each eye (relative to the eye corners and lids), MediaPipe's eye-look blendshapes,
// and head position, mapped to screen coordinates by a ridge regression fitted during a 9-point calibration.

type Pt = { x: number; y: number };
export type Blend = Record<string, number>;

const L = { iris: 473, inner: 362, outer: 263, top: 386, bottom: 374 }; // the person's left eye
const R = { iris: 468, inner: 133, outer: 33, top: 159, bottom: 145 }; // the person's right eye
const NOSE = 1;
const LOOK = ["eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeLookDownLeft", "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight", "eyeLookDownRight"];

function eyeRatios(lm: Pt[], e: typeof L): [number, number] {
  const a = lm[e.inner]!;
  const b = lm[e.outer]!;
  const i = lm[e.iris]!;
  const w = b.x - a.x || 1e-6;
  const h = lm[e.bottom]!.y - lm[e.top]!.y || 1e-6;
  return [(i.x - a.x) / w, (i.y - lm[e.top]!.y) / h];
}

/** Feature vector for one frame (the trailing 1 is the bias term). */
export function gazeFeatures(lm: Pt[], blend: Blend): number[] | undefined {
  if (lm.length < 478) return undefined; // needs the iris landmarks
  const [lx, ly] = eyeRatios(lm, L);
  const [rx, ry] = eyeRatios(lm, R);
  const nose = lm[NOSE]!;
  return [lx, ly, rx, ry, nose.x, nose.y, ...LOOK.map((k) => blend[k] ?? 0), 1];
}

export type GazeModel = { wx: number[]; wy: number[] };

/** Ridge regression from features to screen x and y (both 0..1). Samples: [features, target]. */
export function fitGaze(samples: Array<[number[], Pt]>, lambda = 1e-3): GazeModel {
  const n = samples[0]?.[0].length ?? 0;
  if (!n || samples.length < n) throw new Error("not enough calibration samples");
  const solve = (pick: (p: Pt) => number) => {
    // (XᵀX + λI) w = Xᵀy, solved by Gaussian elimination with partial pivoting.
    const A = Array.from({ length: n }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (j === i && i < n - 1 ? lambda : 0)));
    for (const [f, t] of samples) {
      const y = pick(t);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) A[i]![j]! += f[i]! * f[j]!;
        A[i]![n]! += f[i]! * y;
      }
    }
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
      [A[c], A[p]] = [A[p]!, A[c]!];
      const piv = A[c]![c]! || 1e-12;
      for (let j = c; j <= n; j++) A[c]![j]! /= piv;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const k = A[r]![c]!;
        if (k) for (let j = c; j <= n; j++) A[r]![j]! -= k * A[c]![j]!;
      }
    }
    return A.map((row) => row[n]!);
  };
  return { wx: solve((p) => p.x), wy: solve((p) => p.y) };
}

export function predictGaze(m: GazeModel, f: number[]): Pt {
  const dot = (w: number[]) => w.reduce((s, wi, i) => s + wi * (f[i] ?? 0), 0);
  return { x: Math.min(1, Math.max(0, dot(m.wx))), y: Math.min(1, Math.max(0, dot(m.wy))) };
}

/** 3×3 calibration targets, inset from the edges (fractions of the viewport). */
export const CALIBRATION_POINTS: Pt[] = [0.1, 0.5, 0.9].flatMap((y) => [0.1, 0.5, 0.9].map((x) => ({ x, y })));

/**
 * Exponential smoothing with a dead zone: tiny movements (webcam noise) are ignored, small ones are smoothed
 * heavily, and big jumps (looking somewhere else) are followed faster so the dot doesn't lag across the screen.
 */
export class Smoother {
  private p?: Pt;
  constructor(
    private readonly alpha = 0.12,
    private readonly deadZone = 0.012,
  ) {}
  next(q: Pt): Pt {
    if (!this.p) return (this.p = q);
    const d = Math.hypot(q.x - this.p.x, q.y - this.p.y);
    if (d < this.deadZone) return this.p;
    const a = d > 0.25 ? 0.45 : this.alpha;
    this.p = { x: this.p.x + a * (q.x - this.p.x), y: this.p.y + a * (q.y - this.p.y) };
    return this.p;
  }
}

export type EyeEvent = "click" | "wink_left" | "wink_right";

const CLOSED = 0.5;
const OPEN = 0.3;

/**
 * Long blink (both eyes closed 450-1500 ms) = click. Wink (one eye closed 300-1200 ms while the other stays
 * open) = wink_left / wink_right, named for the person's own eye. Normal blinks are too short to count.
 */
export class BlinkTracker {
  private both?: number;
  private left?: number;
  private right?: number;

  update(blend: Blend, now: number): EyeEvent[] {
    const l = blend.eyeBlinkLeft ?? 0;
    const r = blend.eyeBlinkRight ?? 0;
    const out: EyeEvent[] = [];
    const bothClosed = l > CLOSED && r > CLOSED;
    const leftWink = l > CLOSED + 0.1 && r < OPEN;
    const rightWink = r > CLOSED + 0.1 && l < OPEN;

    if (bothClosed) this.both ??= now;
    else if (this.both !== undefined) {
      const d = now - this.both;
      this.both = undefined;
      if (d >= 450 && d <= 1500) out.push("click");
    }
    if (leftWink) this.left ??= now;
    else if (this.left !== undefined) {
      const d = now - this.left;
      this.left = undefined;
      if (d >= 300 && d <= 1200 && !bothClosed) out.push("wink_left");
    }
    if (rightWink) this.right ??= now;
    else if (this.right !== undefined) {
      const d = now - this.right;
      this.right = undefined;
      if (d >= 300 && d <= 1200 && !bothClosed) out.push("wink_right");
    }
    return out;
  }

  /** 0..1 progress toward a click while both eyes are closed (for the dot's ring). */
  progress(now: number): number {
    return this.both === undefined ? 0 : Math.min(1, (now - this.both) / 450);
  }
}

/** Scroll speed from gaze height: the top/bottom 10% of the screen scrolls that way. */
export function scrollFor(y: number): number {
  if (y < 0.1) return -Math.round(4 + (0.1 - y) * 150);
  if (y > 0.9) return Math.round(4 + (y - 0.9) * 150);
  return 0;
}

/**
 * Only scroll after the gaze has stayed in an edge zone for a moment with nothing clickable under it,
 * so glancing at the top tabs (or a button near the bottom) doesn't move the page.
 */
export class ScrollGate {
  private since?: number;
  constructor(private readonly dwellMs = 500) {}
  update(y: number, onTarget: boolean, now: number): number {
    const dy = scrollFor(y);
    if (!dy || onTarget) {
      this.since = undefined;
      return 0;
    }
    this.since ??= now;
    return now - this.since >= this.dwellMs ? dy : 0;
  }
}
