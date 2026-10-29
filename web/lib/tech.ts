"use client";

import { useEffect, useState } from "react";

// Technical mode (Settings): the Wall shows every diagnostic it can. Per device, like the mood.

const KEY = "wdash:tech";
const EVENT = "wdash:tech";

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setTechMode(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    /* storage blocked: the toggle still works for this page */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: on }));
}

/** Current Technical mode, kept in sync across components and tabs. */
export function useTechMode(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(read());
    const local = (e: Event) => setOn(Boolean((e as CustomEvent<boolean>).detail));
    const other = (e: StorageEvent) => e.key === KEY && setOn(e.newValue === "1");
    window.addEventListener(EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(EVENT, local);
      window.removeEventListener("storage", other);
    };
  }, []);
  return on;
}
