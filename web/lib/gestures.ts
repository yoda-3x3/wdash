// Turns MediaPipe gesture-recognizer output into dashboard gestures. Pure, so it can run per video frame.

export type Pose = "thumb_up" | "thumb_down" | "open_palm" | "fist" | "love" | "point_up" | "point_down" | "none";

/** One-shot actions fired by the tracker; "scroll_*" fire every frame while held. */
export type GestureAction = "approve" | "deny" | "board" | "prev_page" | "next_page" | "dictate" | "send" | "scroll_up" | "scroll_down";

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

/**
 * The model has no "pointing down", so pointing is read from landmarks: index finger extended,
 * middle/ring/pinky curled (tip closer to the wrist than its middle joint), direction from knuckle to tip.
 */
function pointing(lm: Pt[]): Pose | undefined {
  if (lm.length < 21) return undefined;
  const wrist = lm[0]!;
  const extended = (tip: number, pip: number) => dist(lm[tip]!, wrist) > dist(lm[pip]!, wrist) * 1.15;
  const curled = (tip: number, pip: number) => dist(lm[tip]!, wrist) < dist(lm[pip]!, wrist);
  if (!extended(8, 6) || !curled(12, 10) || !curled(16, 14) || !curled(20, 18)) return undefined;
  const dy = lm[8]!.y - lm[5]!.y;
  const len = dist(lm[8]!, lm[5]!);
  if (dy < -0.6 * len) return "point_up";
  if (dy > 0.6 * len) return "point_down";
  return undefined;
}

export function classify(gestures: Category[][], landmarks: Pt[][]): { pose: Pose; wrist?: Pt } {
  const lm = landmarks[0];
  if (!lm) return { pose: "none" };
  const wrist = lm[0];
  const point = pointing(lm);
  if (point) return { pose: point, wrist };
  const top = gestures[0]?.[0];
  if (top && top.score >= 0.6 && CANNED[top.categoryName]) return { pose: CANNED[top.categoryName]!, wrist };
  return { pose: "none", wrist };
}

const HOLD_MS: Partial<Record<Pose, number>> = {
  // Approve/deny act on real requests, so they need a deliberate hold.
  thumb_up: 900,
  thumb_down: 900,
  open_palm: 1200,
  fist: 600,
  love: 700,
};
const POSE_ACTION: Partial<Record<Pose, GestureAction>> = {
  thumb_up: "approve",
  thumb_down: "deny",
  open_palm: "board",
  fist: "send",
  love: "dictate",
};
const SWIPE_WINDOW_MS = 450;
const SWIPE_DISTANCE = 0.22; // fraction of the frame width
const STILL = 0.04;

/** Feed it one classified frame at a time; it returns the actions to run for that frame. */
export class GestureTracker {
  private pose: Pose = "none";
  private since = 0;
  private fired = false;
  private trail: Array<{ t: number; x: number }> = [];
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

    if (pose === "open_palm" && wrist) {
      // Swipes work like a carousel: moving the hand to the user's left shows the next page. The camera image
      // isn't mirrored, so the user's left is +x.
      this.trail.push({ t: now, x: wrist.x });
      this.trail = this.trail.filter((p) => now - p.t <= SWIPE_WINDOW_MS);
      const dx = wrist.x - this.trail[0]!.x;
      if (Math.abs(dx) >= SWIPE_DISTANCE) {
        this.trail = [];
        this.fired = true; // a swipe isn't also a held palm
        this.since = now;
        return [dx > 0 ? "next_page" : "prev_page"];
      }
      // Holding the palm only counts while it stays put.
      if (this.anchor && dist(this.anchor, wrist) > STILL) {
        this.anchor = wrist;
        this.since = now;
      }
    } else {
      this.trail = [];
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
  none: "·",
};

export const LEGEND: Array<[string, string]> = [
  ["👍 hold", "Allow the next permission request"],
  ["👎 hold", "Deny it"],
  ["✋ swipe ←", "Next page (Board → Wall → … → Settings)"],
  ["✋ swipe →", "Previous page"],
  ["✋ hold still", "Go to the Board"],
  ["☝️ / 👇", "Scroll up / down"],
  ["🤟 hold", "Dictate into the chat box"],
  ["✊ hold", "Send the message (stops dictation)"],
];
