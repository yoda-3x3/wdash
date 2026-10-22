// Turns MediaPipe gesture-recognizer output into dashboard gestures. Pure, so it can run per video frame.

export type Pose =
  | "thumb_up"
  | "thumb_down"
  | "open_palm"
  | "fist"
  | "love"
  | "point_up"
  | "point_down"
  | "point_left"
  | "point_right"
  | "count_1"
  | "count_2"
  | "count_3"
  | "count_4"
  | "count_5"
  | "shaka"
  | "none";

/** One-shot actions fired by the tracker; "scroll_*" fire every frame while held. */
export type GestureAction =
  | "approve"
  | "deny"
  | "board"
  | "prev_page"
  | "next_page"
  | "dictate"
  | "send"
  | "scroll_up"
  | "scroll_down"
  | "open_1"
  | "open_2"
  | "open_3"
  | "open_4"
  | "open_5"
  | "toggle_pause";

type Pt = { x: number; y: number };
type Category = { categoryName: string; score: number };

const CANNED: Record<string, Pose> = {
  Thumb_Up: "thumb_up",
  Thumb_Down: "thumb_down",
  Open_Palm: "open_palm",
  Closed_Fist: "fist",
  ILoveYou: "love",
};

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** How sure the model must be of a gesture (and of seeing a hand at all) to act on it. */
export const MIN_CONFIDENCE = 0.5;

/**
 * The model only knows "pointing up", so pointing is read from landmarks: index finger extended,
 * middle/ring/pinky curled (tip closer to the wrist than its middle joint), direction from knuckle to tip.
 * Left/right are from the user's point of view: the camera image isn't mirrored, so the user's right is -x.
 */
function pointing(lm: Pt[]): Pose | undefined {
  if (lm.length < 21) return undefined;
  const wrist = lm[0]!;
  const extended = (tip: number, pip: number) => dist(lm[tip]!, wrist) > dist(lm[pip]!, wrist) * 1.15;
  const curled = (tip: number, pip: number) => dist(lm[tip]!, wrist) < dist(lm[pip]!, wrist);
  if (!extended(8, 6) || !curled(12, 10) || !curled(16, 14) || !curled(20, 18)) return undefined;
  const dx = lm[8]!.x - lm[5]!.x;
  const dy = lm[8]!.y - lm[5]!.y;
  const len = dist(lm[8]!, lm[5]!);
  if (dy < -0.6 * len) return "point_up";
  if (dy > 0.6 * len) return "point_down";
  if (dx < -0.6 * len) return "point_right";
  if (dx > 0.6 * len) return "point_left";
  return undefined;
}

/**
 * Fingers held up, 0-5: index, middle, ring and pinky when extended, plus the thumb when it sticks out
 * alongside them. Only counts an upright hand (fingers above the wrist), so sideways pointing isn't a count.
 */
export function fingerCount(lm: Pt[]): number {
  if (lm.length < 21) return 0;
  const wrist = lm[0]!;
  const palm = dist(wrist, lm[9]!);
  if (lm[9]!.y > wrist.y - 0.3 * palm) return 0; // not upright
  const up = (tip: number, pip: number) => dist(lm[tip]!, wrist) > dist(lm[pip]!, wrist) * 1.15 && lm[tip]!.y < lm[pip]!.y;
  if (!up(8, 6)) return 0; // counting starts with the index finger (so 🤙 isn't a 2)
  const fingers = [up(8, 6), up(12, 10), up(16, 14), up(20, 18)].filter(Boolean).length;
  const thumbOut = dist(lm[4]!, lm[5]!) > 0.55 * palm && dist(lm[4]!, lm[17]!) > dist(lm[3]!, lm[17]!) * 1.05;
  return fingers + (fingers > 0 && thumbOut ? 1 : 0);
}

/** 🤙: thumb and pinky out, index/middle/ring curled. Pauses and resumes tracking. */
function shaka(lm: Pt[]): boolean {
  if (lm.length < 21) return false;
  const wrist = lm[0]!;
  const palm = dist(wrist, lm[9]!);
  const extended = (tip: number, pip: number) => dist(lm[tip]!, wrist) > dist(lm[pip]!, wrist) * 1.15;
  const curled = (tip: number, pip: number) => dist(lm[tip]!, wrist) < dist(lm[pip]!, wrist);
  const thumbOut = dist(lm[4]!, lm[5]!) > 0.55 * palm;
  return thumbOut && extended(20, 18) && curled(8, 6) && curled(12, 10) && curled(16, 14);
}

/** `countFingers`: read an upright hand as a number (the Wall uses it to open tiles). */
export function classify(gestures: Category[][], landmarks: Pt[][], opts: { countFingers?: boolean } = {}): { pose: Pose; wrist?: Pt } {
  const lm = landmarks[0];
  if (!lm) return { pose: "none" };
  const wrist = lm[0];
  if (shaka(lm)) return { pose: "shaka", wrist };
  if (opts.countFingers) {
    const n = fingerCount(lm);
    if (n >= 1 && n <= 5) return { pose: `count_${n}` as Pose, wrist };
  }
  const point = pointing(lm);
  if (point) return { pose: point, wrist };
  const top = gestures[0]?.[0];
  if (top && top.score >= MIN_CONFIDENCE && CANNED[top.categoryName]) return { pose: CANNED[top.categoryName]!, wrist };
  return { pose: "none", wrist };
}

const HOLD_MS: Partial<Record<Pose, number>> = {
  // Approve/deny act on real requests, so they still need the longest hold.
  thumb_up: 500,
  thumb_down: 500,
  open_palm: 700,
  fist: 350,
  love: 400,
  point_left: 300,
  point_right: 300,
  count_1: 450,
  count_2: 450,
  count_3: 450,
  count_4: 450,
  count_5: 450,
  shaka: 600,
};
const POSE_ACTION: Partial<Record<Pose, GestureAction>> = {
  thumb_up: "approve",
  thumb_down: "deny",
  open_palm: "board",
  fist: "send",
  love: "dictate",
  point_right: "next_page",
  point_left: "prev_page",
  count_1: "open_1",
  count_2: "open_2",
  count_3: "open_3",
  count_4: "open_4",
  count_5: "open_5",
  shaka: "toggle_pause",
};
const STILL = 0.04;

/** Feed it one classified frame at a time; it returns the actions to run for that frame. */
export class GestureTracker {
  private pose: Pose = "none";
  private since = 0;
  private fired = false;
  private anchor?: Pt;

  update(pose: Pose, wrist: Pt | undefined, now: number): GestureAction[] {
    if (pose !== this.pose) {
      this.pose = pose;
      this.since = now;
      this.fired = false;
      this.anchor = wrist;
    }
    if (pose === "point_up") return ["scroll_up"];
    if (pose === "point_down") return ["scroll_down"];

    // Holding the palm only counts while it stays put.
    if (pose === "open_palm" && wrist && this.anchor && dist(this.anchor, wrist) > STILL) {
      this.anchor = wrist;
      this.since = now;
    }

    const hold = HOLD_MS[pose];
    const action = POSE_ACTION[pose];
    if (hold && action && !this.fired && now - this.since >= hold) {
      this.fired = true;
      return [action];
    }
    return [];
  }

  /** 0..1 progress of the current hold, for a ring in the UI. */
  progress(now: number): number {
    const hold = HOLD_MS[this.pose];
    if (!hold || this.fired) return 0;
    return Math.min(1, (now - this.since) / hold);
  }

  get current(): Pose {
    return this.pose;
  }
}

export const POSE_EMOJI: Record<Pose, string> = {
  thumb_up: "👍",
  thumb_down: "👎",
  open_palm: "✋",
  fist: "✊",
  love: "🤟",
  point_up: "☝️",
  point_down: "👇",
  point_left: "👈",
  point_right: "👉",
  count_1: "1️⃣",
  count_2: "2️⃣",
  count_3: "3️⃣",
  count_4: "4️⃣",
  count_5: "5️⃣",
  shaka: "🤙",
  none: "·",
};

export const LEGEND: Array<[string, string]> = [
  ["👍 hold", "Allow the next permission request"],
  ["👎 hold", "Deny it"],
  ["👉 point right", "Next page (Board → Wall → … → Settings)"],
  ["👈 point left", "Previous page"],
  ["✋ hold still", "Go to the Board"],
  ["☝️ / 👇", "Scroll up / down"],
  ["🤟 hold", "Dictate into the chat box"],
  ["✊ hold", "Send the message (stops dictation)"],
  ["1–5 fingers up", "On the Wall: open tile 1–5"],
  ["🤙 hold", "Pause / resume gesture tracking"],
];
