"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import type { Attention, JobRecord, RateLimitInfo } from "@wdash/shared";
import { usePoll } from "@/lib/client";
import { PAGES, slideIn, swipeTo, touchSwipeHandlers } from "@/lib/swipe";
import { Gestures } from "./Gestures";

export type BoardState = {
  jobs: JobRecord[];
  home: { online: boolean; lastSeen?: number };
  attention: Attention[];
  paused: boolean;
  rateLimits: RateLimitInfo[];
  now: number;
};

const Ctx = createContext<{ state: BoardState | undefined; refresh: () => void; error?: string }>({ state: undefined, refresh: () => {} });
export const useBoard = () => useContext(Ctx);

const NAV = PAGES;

export function Shell({ children, wide = false }: { children: React.ReactNode; wide?: boolean }) {
  const { data, refresh, error } = usePoll<BoardState>("/api/state", 5000);
  const path = usePathname();
  const router = useRouter();
  const inbox = data?.attention.length ?? 0;
  const main = useRef<HTMLElement>(null);

  // Arriving by a swipe: slide the new page in.
  useEffect(() => slideIn(main.current), [path]);

  const touch = useMemo(() => touchSwipeHandlers((dir) => void swipeTo(router.push, location.pathname, dir)), [router]);

  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  useEffect(() => {
    document.title = inbox ? `(${inbox}) wdash` : "wdash";
  }, [inbox]);

  return (
    <Ctx.Provider value={{ state: data, refresh, error }}>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className={`mx-auto flex items-center gap-3 px-4 py-2.5 ${wide ? "" : "max-w-5xl"}`}>
          <Link href="/" className="flex items-center gap-2 font-semibold">
            <img src="/icon.svg" alt="" className="h-6 w-6" />
            <span className="hidden sm:inline">wdash</span>
          </Link>
          <PcDot online={data?.home.online} />
          <Gestures />
          {data?.paused && <span className="chip bg-warn/15 text-warn">paused</span>}
          <nav className="ml-auto flex items-center gap-1 overflow-x-auto text-sm">
            {NAV.map((n) => {
              const active = n.href === "/" ? path === "/" : path.startsWith(n.href);
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  className={`relative rounded-lg px-2.5 py-1.5 ${active ? "bg-panel-2 font-medium" : "text-muted hover:text-fg"} ${n.href === "/new" || n.href === "/chat/new" ? "hidden sm:inline-flex" : ""}`}
                >
                  {n.label}
                  {n.href === "/inbox" && inbox > 0 && (
                    <span className="ml-1 rounded-full bg-bad px-1.5 text-[11px] font-semibold text-white">{inbox}</span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
        {error && error !== "signed out" && <div className="bg-bad/10 px-4 py-1 text-center text-xs text-bad">Can't reach wdash: {error}</div>}
      </header>
      <div className="overflow-x-clip">
        <main ref={main} data-page {...touch} className={`mx-auto px-4 pb-24 pt-4 ${wide ? "" : "max-w-5xl"}`}>
          {children}
        </main>
      </div>
      {!wide && (
      <Link
        href="/new"
        className="btn btn-primary fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 z-20 rounded-full px-5 py-3 shadow-lg sm:hidden"
      >
        + New
      </Link>
      )}
    </Ctx.Provider>
  );
}

function PcDot({ online }: { online: boolean | undefined }) {
  if (online === undefined) return null;
  return (
    <span className={`chip shrink-0 ${online ? "bg-ok/15 text-ok" : "bg-panel-2 text-muted"}`} title={online ? "Home PC online" : "Home PC offline — jobs run in the cloud"}>
      <span className={`h-1.5 w-1.5 rounded-full ${online ? "bg-ok" : "bg-muted"}`} />
      <span className="hidden sm:inline">PC {online ? "online" : "offline"}</span>
    </span>
  );
}
