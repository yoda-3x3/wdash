"use client";

// Swiping between the top-level pages (camera gesture or touch), with a slide animation.

/** Main pages, in nav order. Swiping left goes to the next one, right to the previous; it wraps. */
export const PAGES = [
  { href: "/", label: "Wall" },
  { href: "/inbox", label: "Inbox" },
  { href: "/settings", label: "Settings" },
] as const;

export type SwipeDir = "next" | "prev";

/** Which page a path belongs to; job and form pages count as the Wall. */
export function pageIndex(path: string): number {
  const i = PAGES.findIndex((p) => (p.href === "/" ? path === "/" : path === p.href || path.startsWith(`${p.href}/`)));
  return i < 0 ? 0 : i;
}

export function neighbor(path: string, dir: SwipeDir): (typeof PAGES)[number] {
  const i = pageIndex(path);
  return PAGES[(i + (dir === "next" ? 1 : -1) + PAGES.length) % PAGES.length]!;
}

const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// Set just before navigating so the incoming page knows which side to slide in from.
let pending: SwipeDir | undefined;

/** Slide the current page out, then navigate; the new page slides in from the other side. */
export async function swipeTo(push: (href: string) => void, path: string, dir: SwipeDir): Promise<string> {
  const target = neighbor(path, dir);
  const main = document.querySelector<HTMLElement>("main[data-page]");
  pending = dir;
  if (main && !reduced()) {
    await main
      .animate(
        [
          { transform: "translateX(0)", opacity: 1 },
          { transform: `translateX(${dir === "next" ? "-18%" : "18%"})`, opacity: 0 },
        ],
        { duration: 160, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" },
      )
      .finished.catch(() => undefined);
  }
  push(target.href);
  return target.label;
}

/** Called when a page's main element mounts: slide in if we got here by swiping. */
export function slideIn(main: HTMLElement | null): void {
  const dir = pending;
  pending = undefined;
  if (!dir || !main || reduced()) return;
  main.animate(
    [
      { transform: `translateX(${dir === "next" ? "22%" : "-22%"})`, opacity: 0 },
      { transform: "translateX(0)", opacity: 1 },
    ],
    { duration: 240, easing: "cubic-bezier(0,0,.2,1)" },
  );
}

/**
 * Touch swipes on phones. Ignores swipes that start in text fields, code, things that scroll sideways,
 * or near the screen edges (the browser's own back/forward gesture lives there).
 */
export function touchSwipeHandlers(onSwipe: (dir: SwipeDir) => void) {
  let start: { x: number; y: number; t: number } | undefined;
  const blocked = (el: EventTarget | null): boolean => {
    for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
      if (n.matches?.("input, textarea, select, pre, code, video, [data-no-swipe]")) return true;
      if (n.scrollWidth > n.clientWidth + 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) return true;
    }
    return false;
  };
  return {
    onTouchStart(e: React.TouchEvent) {
      const t = e.touches[0];
      start = e.touches.length === 1 && t && t.clientX > 24 && t.clientX < window.innerWidth - 24 && !blocked(e.target) ? { x: t.clientX, y: t.clientY, t: Date.now() } : undefined;
    },
    onTouchEnd(e: React.TouchEvent) {
      const t = e.changedTouches[0];
      if (!start || !t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      const quick = Date.now() - start.t < 600;
      start = undefined;
      if (quick && Math.abs(dx) > 80 && Math.abs(dx) > 2 * Math.abs(dy)) onSwipe(dx < 0 ? "next" : "prev");
    },
  };
}
