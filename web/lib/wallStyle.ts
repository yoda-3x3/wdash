"use client";

import { useEffect, useState } from "react";

// How the Wall draws agents (Settings): terminal tiles, or an arcade-style office or kitchen. Per device.

export const WALL_STYLES = { terminal: "Terminal", office: "Office", kitchen: "Kitchen" } as const;
export type WallStyle = keyof typeof WALL_STYLES;

const KEY = "wdash:wallStyle";
const EVENT = "wdash:wallStyle";

function read(): WallStyle {
  try {
    const v = localStorage.getItem(KEY);
    return v && v in WALL_STYLES ? (v as WallStyle) : "terminal";
  } catch {
    return "terminal";
  }
}

export function setWallStyle(style: WallStyle): void {
  try {
    localStorage.setItem(KEY, style);
  } catch {
    /* storage blocked: still switches for this page */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: style }));
}

export function useWallStyle(): WallStyle {
  const [style, setStyle] = useState<WallStyle>("terminal");
  useEffect(() => {
    setStyle(read());
    const local = (e: Event) => setStyle((e as CustomEvent<WallStyle>).detail);
    const other = (e: StorageEvent) => e.key === KEY && setStyle(read());
    window.addEventListener(EVENT, local);
    window.addEventListener("storage", other);
    return () => {
      window.removeEventListener(EVENT, local);
      window.removeEventListener("storage", other);
    };
  }, []);
  return style;
}
