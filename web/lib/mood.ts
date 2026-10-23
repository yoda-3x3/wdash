// Visual moods (themes). Stored per device; applied to <html data-mood> before first paint by app/layout.tsx.

export const MOOD_KEY = "wdash:mood";
export const DEFAULT_MOOD = "hacker";

export const MOODS = [
  { id: "hacker", label: "Hacker", swatch: ["#050805", "#39ff6a"], about: "Green terminal, scanlines" },
  { id: "defcon", label: "DEFCON", swatch: ["#0a0000", "#ff1f2d"], about: "Red alert" },
  { id: "cyberpunk", label: "Cyberpunk", swatch: ["#0d0221", "#ff2a6d"], about: "Neon pink and cyan" },
  { id: "amber", label: "Amber", swatch: ["#0b0700", "#ffb000"], about: "Old-school amber CRT" },
  { id: "midnight", label: "Midnight", swatch: ["#0b1020", "#7aa2ff"], about: "Calm dark blue" },
  { id: "classic", label: "Classic", swatch: ["#f6f7f9", "#4f46e5"], about: "Clean; follows light/dark" },
] as const;

export type Mood = (typeof MOODS)[number]["id"];

/** Runs inline in <head> so the right colors are there on the first frame. */
export const MOOD_BOOT = `try{var m=localStorage.getItem("${MOOD_KEY}")||"${DEFAULT_MOOD}";if(m!=="classic")document.documentElement.dataset.mood=m}catch(e){document.documentElement.dataset.mood="${DEFAULT_MOOD}"}`;

export function applyMood(m: Mood): void {
  if (m === "classic") delete document.documentElement.dataset.mood;
  else document.documentElement.dataset.mood = m;
  try {
    localStorage.setItem(MOOD_KEY, m);
  } catch {
    /* storage blocked */
  }
}

export function currentMood(): Mood {
  return ((typeof document !== "undefined" && (document.documentElement.dataset.mood as Mood)) || "classic") as Mood;
}
