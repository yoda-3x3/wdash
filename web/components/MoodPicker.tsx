"use client";

import { useEffect, useState } from "react";
import { MOODS, applyMood, currentMood, type Mood } from "@/lib/mood";

export function MoodPicker() {
  const [mood, setMood] = useState<Mood>();
  useEffect(() => setMood(currentMood()), []);
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {MOODS.map((m) => (
        <button
          key={m.id}
          type="button"
          onClick={() => {
            applyMood(m.id);
            setMood(m.id);
          }}
          className={`flex items-center gap-2 rounded-lg border p-2 text-left text-sm ${mood === m.id ? "border-accent" : "border-line hover:bg-panel-2"}`}
          aria-pressed={mood === m.id}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded" style={{ background: m.swatch[0], border: `1px solid ${m.swatch[1]}` }}>
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: m.swatch[1], boxShadow: `0 0 6px ${m.swatch[1]}` }} />
          </span>
          <span className="min-w-0">
            <span className="block font-medium">{m.label}</span>
            <span className="block truncate text-xs text-muted">{m.about}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
