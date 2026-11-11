"use client";

import { useEffect, useState } from "react";

/** A per-device on/off setting in localStorage, kept in sync across components and tabs. */
export function useFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(readFlag(key));
    const local = (e: Event) => {
      const d = (e as CustomEvent<{ key: string; on: boolean }>).detail;
      if (d.key === key) setOn(d.on);
    };
    const other = (e: StorageEvent) => e.key === key && setOn(e.newValue === "1");
    window.addEventListener("wdash:flag", local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener("wdash:flag", local);
      window.removeEventListener("storage", other);
    };
  }, [key]);
  return [on, (v: boolean) => setFlag(key, v)];
}

export function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function setFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? "1" : "0");
  } catch {
    /* storage blocked */
  }
  window.dispatchEvent(new CustomEvent("wdash:flag", { detail: { key, on } }));
}

/** Settings > Look exactly like the CLI: the whole site becomes one terminal. /exit leaves it. */
export const CLI_MODE = "wdash:cliMode";

/** True inside the browser pane's iframes: pages there drop the header, pane and CLI mode. */
export function isEmbedded(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    return true;
  }
}
