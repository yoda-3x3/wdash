"use client";

import { createContext, useContext, useEffect, useRef, useState } from "react";

/**
 * A browser inside the website: Wall tiles (and any URL) open as tabs in a side pane, so you can watch several
 * jobs next to the Wall. wdash pages load in an iframe without their header (lib/prefs.ts isEmbedded()).
 * Other sites load too unless they forbid framing; "↗" opens the tab in a real browser tab.
 */
type Tab = { id: string; url: string; title: string };
type Pane = { open: (url: string, title?: string) => void; toggle: () => void; shown: boolean; count: number };

const TABS_KEY = "wdash:browserTabs";
const SHOWN_KEY = "wdash:browserShown";
const ACTIVE_KEY = "wdash:browserActive";
const Ctx = createContext<Pane | undefined>(undefined);

/** The pane, or undefined outside the provider (e.g. inside the pane's own iframes). */
export const useBrowserPane = () => useContext(Ctx);

/** Click handler for links that should open in the pane (plain clicks only; Ctrl/⌘/middle clicks behave normally). */
export function openInPane(pane: Pane | undefined, url: string, title?: string) {
  return (e: React.MouseEvent) => {
    if (!pane || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    pane.open(url, title);
  };
}

function load(): Tab[] {
  try {
    const t = JSON.parse(localStorage.getItem(TABS_KEY) ?? "[]") as Tab[];
    return Array.isArray(t) ? t.slice(0, 12) : [];
  } catch {
    return [];
  }
}

const isLocal = (url: string) => url.startsWith("/");

function normalize(input: string): string {
  const s = input.trim();
  if (!s) return "";
  if (s.startsWith("/")) return s;
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

export function BrowserProvider({ children }: { children: React.ReactNode }) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string>();
  const [shown, setShown] = useState(false);

  const ready = useRef(false);
  // Every page has its own Shell, so the pane's state lives in localStorage and survives navigation.
  useEffect(() => {
    const t = load();
    setTabs(t);
    try {
      setActive(localStorage.getItem(ACTIVE_KEY) ?? t[0]?.id);
      setShown(t.length > 0 && localStorage.getItem(SHOWN_KEY) === "1");
    } catch {
      setActive(t[0]?.id);
    }
    ready.current = true;
  }, []);
  useEffect(() => {
    if (!ready.current) return;
    try {
      localStorage.setItem(TABS_KEY, JSON.stringify(tabs));
      localStorage.setItem(SHOWN_KEY, shown ? "1" : "0");
      if (active) localStorage.setItem(ACTIVE_KEY, active);
    } catch {
      /* storage blocked */
    }
  }, [tabs, shown, active]);

  const open = (raw: string, title?: string) => {
    const url = normalize(raw);
    if (!url) return;
    setShown(true);
    const same = tabs.find((t) => t.url === url);
    if (same) return setActive(same.id);
    const tab = { id: Math.random().toString(36).slice(2, 9), url, title: title ?? label(url) };
    setTabs((prev) => [...prev, tab].slice(-12));
    setActive(tab.id);
  };
  const close = (id: string) => {
    const rest = tabs.filter((t) => t.id !== id);
    setTabs(rest);
    if (active === id) setActive(rest[rest.length - 1]?.id);
    if (!rest.length) setShown(false);
  };
  const navigate = (id: string, raw: string) => {
    const url = normalize(raw);
    if (url) setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, url, title: label(url) } : t)));
  };

  const pane: Pane = { open, toggle: () => setShown((s) => !s), shown, count: tabs.length };
  const cur = tabs.find((t) => t.id === active);

  return (
    <Ctx.Provider value={pane}>
      <div className={shown ? "lg:mr-[min(48vw,820px)]" : ""}>{children}</div>
      {shown && (
        <aside className="browser-pane fixed inset-0 z-30 flex flex-col border-l border-line bg-bg lg:inset-y-0 lg:left-auto lg:right-0 lg:w-[min(48vw,820px)]" aria-label="Browser">
          <div className="flex items-center gap-1 overflow-x-auto border-b border-line bg-panel px-1 pt-1 text-xs">
            {tabs.map((t) => (
              <div key={t.id} className={`group flex max-w-48 shrink-0 items-center gap-1 rounded-t-md px-2 py-1 ${t.id === active ? "bg-bg text-fg" : "text-muted hover:text-fg"}`}>
                <button type="button" className="truncate" onClick={() => setActive(t.id)} title={t.url}>
                  {t.title}
                </button>
                <button type="button" className="opacity-60 hover:opacity-100" onClick={() => close(t.id)} aria-label={`Close ${t.title}`}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="px-2 py-1 text-muted hover:text-fg" onClick={() => open("/")} title="New tab (the Wall)">
              +
            </button>
            <button type="button" className="ml-auto px-2 py-1 text-muted hover:text-fg" onClick={() => setShown(false)} title="Hide the browser">
              ✕
            </button>
          </div>
          {cur ? (
            <>
              <AddressBar key={cur.id + cur.url} url={cur.url} onGo={(u) => navigate(cur.id, u)} />
              <iframe key={cur.id + cur.url} src={cur.url} title={cur.title} className="min-h-0 flex-1 bg-bg" />
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted">
              Click a tile on the Wall to open it here, or press + for a new tab.
            </div>
          )}
        </aside>
      )}
    </Ctx.Provider>
  );
}

function AddressBar({ url, onGo }: { url: string; onGo: (u: string) => void }) {
  const [v, setV] = useState(url);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <form
      className="flex items-center gap-1 border-b border-line bg-panel px-2 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        onGo(v);
        ref.current?.blur();
      }}
    >
      <input ref={ref} className="input h-7 flex-1 py-0 text-xs" value={v} onChange={(e) => setV(e.target.value)} aria-label="Address" placeholder="URL, wdash path (/inbox) or search" />
      <a className="btn h-7 px-2 py-0 text-xs" href={url} target="_blank" rel="noreferrer" title="Open in a real browser tab">
        ↗
      </a>
      {!isLocal(url) && <span className="hidden text-[10px] text-muted sm:inline">blank? the site blocks framing: use ↗</span>}
    </form>
  );
}

function label(url: string): string {
  if (url === "/") return "Wall";
  const job = url.match(/^\/jobs\/([\w-]+)/);
  if (job) return `job ${job[1]!.slice(-6)}`;
  if (isLocal(url)) return url.slice(1).split(/[/?#]/)[0] || "wdash";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url.slice(0, 30);
  }
}
