// Face-gesture control from MediaPipe Face Landmarker output: head turns/tilts and expressions.
// Pure, so it runs per video frame and can be tested.

import type { GestureAction } from "./gestures";

type Pt = { x: number; y: number };
export type Blend = Record<string, number>;

export type FacePose =
  | "turn_left"
  | "turn_right"
  | "tilt_up"
  | "tilt_down"
  | "wink_left"
  | "wink_right"
  | "brows"
  | "mouth_open"
  | "smile"
  | "none";

/**
 * Head yaw/pitch from landmarks, roughly 0 when facing the camera.
 * yaw: nose offset from the midpoint of the cheeks, over face width. The camera image isn't mirrored, so
 * turning to the person's right moves the nose to image-left (negative).
 * pitch: nose height between the eye line and the mouth (0 = halfway); looking up gives negative.
 */
export function headPose(lm: Pt[]): { yaw: number; pitch: number } | undefined {
  if (lm.length < 468) return undefined;
  const nose = lm[1]!;
  const l = lm[234]!;
  const r = lm[454]!;
  const width = Math.abs(r.x - l.x) || 1e-6;
  const eyesY = (lm[33]!.y + lm[263]!.y) / 2;
  const mouthY = lm[13]!.y;
  const span = mouthY - eyesY || 1e-6;
  return { yaw: (nose.x - (l.x + r.x) / 2) / width, pitch: (nose.y - eyesY) / span - 0.5 };
}

const YAW = 0.11; // ≈ a deliberate head turn
const PITCH = 0.12;
const avg = (b: Blend, ...k: string[]) => k.reduce((s, x) => s + (b[x] ?? 0), 0) / k.length;

/** Which face gesture this frame shows, given the person's neutral head pose. Expressions win over head moves. */
export function classifyFace(pose: { yaw: number; pitch: number }, neutral: { yaw: number; pitch: number }, b: Blend): FacePose {
  const l = b.eyeBlinkLeft ?? 0;
  const r = b.eyeBlinkRight ?? 0;
  if (l > 0.6 && r < 0.3) return "wink_left";
  if (r > 0.6 && l < 0.3) return "wink_right";
  if ((b.jawOpen ?? 0) > 0.5) return "mouth_open";
  if (avg(b, "mouthSmileLeft", "mouthSmileRight") > 0.6) return "smile";
  if (Math.max(b.browInnerUp ?? 0, avg(b, "browOuterUpLeft", "browOuterUpRight")) > 0.6) return "brows";
  const dy = pose.yaw - neutral.yaw;
  const dp = pose.pitch - neutral.pitch;
  if (Math.abs(dy) > YAW && Math.abs(dy) >= Math.abs(dp)) return dy < 0 ? "turn_right" : "turn_left";
  if (dp < -PITCH) return "tilt_up";
  if (dp > PITCH) return "tilt_down";
  return "none";
}

const HOLD_MS: Partial<Record<FacePose, number>> = {
  turn_left: 350,
  turn_right: 350,
  wink_left: 250,
  wink_right: 250,
  brows: 500,
  mouth_open: 600,
  smile: 600,
};
const ACTION: Partial<Record<FacePose, GestureAction>> = {
  turn_right: "next_page",
  turn_left: "prev_page",
  wink_left: "approve",
  wink_right: "deny",
  brows: "board",
  mouth_open: "dictate",
  smile: "send",
};
const SCROLL_AFTER_MS = 250;

/** Learns the neutral head pose, then turns frames into actions (one per held gesture; scrolling repeats). */
export class FaceTracker {
  private neutral?: { yaw: number; pitch: number };
  private warm: Array<{ yaw: number; pitch: number }> = [];
  private pose: FacePose = "none";
  private since = 0;
  private fired = false;

  update(head: { yaw: number; pitch: number } | undefined, blend: Blend, now: number): GestureAction[] {
    if (!head) return this.set("none", now), [];
    // First ~15 frames: learn where "facing the screen" is.
    if (!this.neutral) {
      this.warm.push(head);
      if (this.warm.length < 15) return [];
      this.neutral = {
        yaw: this.warm.reduce((s, h) => s + h.yaw, 0) / this.warm.length,
        pitch: this.warm.reduce((s, h) => s + h.pitch, 0) / this.warm.length,
      };
    }
    const pose = classifyFace(head, this.neutral, blend);
    // Drift slowly toward the current pose while resting, so posture changes don't trigger gestures.
    if (pose === "none") {
      this.neutral.yaw += 0.01 * (head.yaw - this.neutral.yaw);
      this.neutral.pitch += 0.01 * (head.pitch - this.neutral.pitch);
    }
    this.set(pose, now);
    if ((pose === "tilt_up" || pose === "tilt_down") && now - this.since >= SCROLL_AFTER_MS) return [pose === "tilt_up" ? "scroll_up" : "scroll_down"];
    const hold = HOLD_MS[pose];
    const action = ACTION[pose];
    if (hold && action && !this.fired && now - this.since >= hold) {
      this.fired = true;
      return [action];
    }
    return [];
  }

  private set(pose: FacePose, now: number) {
    if (pose === this.pose) return;
    this.pose = pose;
    this.since = now;
    this.fired = false;
  }

  get current(): FacePose {
    return this.pose;
  }

  get ready(): boolean {
    return !!this.neutral;
  }

  progress(now: number): number {
    const hold = HOLD_MS[this.pose];
    return !hold || this.fired ? 0 : Math.min(1, (now - this.since) / hold);
  }
}

export const FACE_EMOJI: Record<FacePose, string> = {
  turn_left: "⬅️",
  turn_right: "➡️",
  tilt_up: "⬆️",
  tilt_down: "⬇️",
  wink_left: "😉",
  wink_right: "😉",
  brows: "🤨",
  mouth_open: "😮",
  smile: "😄",
  none: "🙂",
};

export const FACE_LEGEND: Array<[string, string]> = [
  ["Turn head ➡️ / ⬅️", "Next / previous page"],
  ["Tilt head ⬆️ / ⬇️", "Scroll up / down"],
  ["😉 left eye", "Allow the next permission request"],
  ["😉 right eye", "Deny it"],
  ["🤨 raise eyebrows", "Go to the Board"],
  ["😮 open mouth", "Dictate into the chat box"],
  ["😄 smile", "Send the message"],
];
