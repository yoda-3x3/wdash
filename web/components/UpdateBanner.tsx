"use client";

import { useEffect, useState } from "react";

const BUILT = process.env.NEXT_PUBLIC_BUILD_VERSION ?? "dev";

/** An open tab keeps its old code until a full reload; this says when a newer deploy is live. */
export function UpdateBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (BUILT === "dev") return;
    const check = async () => {
      try {
        const r = await fetch("/api/version", { cache: "no-store" });
        const { version } = (await r.json()) as { version: string };
        if (version && version !== "dev" && version !== BUILT) setStale(true);
      } catch {
        /* offline; try later */
      }
    };
    void check();
    const t = setInterval(check, 60_000);
    const onVisible = () => document.visibilityState === "visible" && void check();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  if (!stale) return null;
  return (
    <div className="flex items-center justify-center gap-3 bg-accent/15 px-4 py-1.5 text-xs">
      <span>A new version of wdash is ready.</span>
      <button className="btn btn-primary px-3 py-1 text-xs" onClick={() => location.reload()}>
        Reload
      </button>
    </div>
  );
}
