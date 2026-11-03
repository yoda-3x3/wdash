"use client";

import Link from "next/link";
import type { AgentRecord, JobRecord } from "@wdash/shared";
import { projectLabel } from "@wdash/shared";
import { usd } from "@/lib/client";

// Arcade Wall (Settings > Wall style): each live job is a room, each agent a character acting out its status.

export type ArcadeTile = { key: string; job: JobRecord; agent: AgentRecord; say?: string; needsYou: boolean; n?: number };
type Theme = "office" | "kitchen";

const CAST: Record<Theme, Record<string, { who: string; prop: string; busy: string; idle: string }>> = {
  office: {
    orchestrator: { who: "🧑‍💼", prop: "📋", busy: "💬", idle: "☕" },
    lead: { who: "👩‍💼", prop: "🗂️", busy: "💬", idle: "☕" },
    worker: { who: "🧑‍💻", prop: "🖥️", busy: "⌨️", idle: "☕" },
    chat: { who: "🧑‍💻", prop: "💻", busy: "⌨️", idle: "☕" },
  },
  kitchen: {
    orchestrator: { who: "👨‍🍳", prop: "📜", busy: "🔔", idle: "🍵" },
    lead: { who: "🧑‍🍳", prop: "🥘", busy: "♨️", idle: "🍵" },
    worker: { who: "🧑‍🍳", prop: "🍳", busy: "♨️", idle: "🧂" },
    chat: { who: "🧑‍🍳", prop: "🍲", busy: "♨️", idle: "🍵" },
  },
};

const ROOM: Record<Theme, { floor: string; wall: string; deco: string; sign: string }> = {
  office: {
    floor: "repeating-conic-gradient(#1b2230 0 25%, #161c27 0 50%) 0 0 / 28px 28px",
    wall: "linear-gradient(#2a3444, #222b39)",
    deco: "🪴 🖼️ 🪟 ⏰ 🪟 🗄️",
    sign: "📁",
  },
  kitchen: {
    floor: "repeating-conic-gradient(#e8e4da 0 25%, #c9c3b6 0 50%) 0 0 / 28px 28px",
    wall: "linear-gradient(#5b3d2e, #4a3125)",
    deco: "🧄 🌶️ 🥖 🧀 🍅 🫙",
    sign: "🍽️",
  },
};

/** Model badge: which brain the character runs on. */
function modelBadge(model: string): { mark: string; color: string } {
  if (model.startsWith("kaggle")) return { mark: "🤖", color: "#34d399" };
  if (model.includes("opus")) return { mark: "O", color: "#c084fc" };
  if (model.includes("sonnet")) return { mark: "S", color: "#60a5fa" };
  if (model.includes("haiku")) return { mark: "H", color: "#4ade80" };
  return { mark: "?", color: "#9ca3af" };
}

export function ArcadeScene({ theme, tiles }: { theme: Theme; tiles: ArcadeTile[] }) {
  const room = ROOM[theme];
  const jobs = new Map<string, { job: JobRecord; tiles: ArcadeTile[] }>();
  for (const t of tiles) {
    const g = jobs.get(t.job.id) ?? { job: t.job, tiles: [] };
    g.tiles.push(t);
    jobs.set(t.job.id, g);
  }
  return (
    <div className="space-y-3">
      <style>{ARCADE_CSS}</style>
      {[...jobs.values()].map(({ job, tiles: crew }) => (
        <section key={job.id} className="overflow-hidden rounded-md border-2 border-[#0b0d10] shadow-[0_0_0_2px_#2a2f39]">
          <Link href={`/jobs/${job.id}`} className="arcade-font flex items-center gap-2 px-2 py-1.5 text-[10px] text-[#f5f5f4] hover:brightness-125" style={{ background: room.wall }}>
            <span>{room.sign}</span>
            <span className="truncate uppercase">{projectLabel(job.project)} · {job.title}</span>
            <span className="ml-auto shrink-0 text-[#fbbf24]">{usd(job.costUsd)}</span>
          </Link>
          <div className="arcade-font select-none px-2 pt-1 text-center text-sm tracking-[0.6em] opacity-70" style={{ background: room.wall }}>
            {room.deco}
          </div>
          <div className="grid gap-3 p-3" style={{ background: room.floor, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 150px), 1fr))" }}>
            {crew.map((t) => (
              <Station key={t.key} theme={theme} t={t} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function Station({ theme, t }: { theme: Theme; t: ArcadeTile }) {
  const { agent } = t;
  const cast = CAST[theme][agent.role] ?? CAST[theme].worker!;
  const status = t.needsYou ? "needs" : agent.status;
  const busy = ["running", "starting", "reviewing"].includes(status);
  const failed = status === "failed";
  const done = status === "done" || status === "stopped";
  const badge = modelBadge(agent.model);
  const action = failed ? "💨" : status === "needs" || status === "waiting_on_user" || status === "waiting_on_approval" ? "❗" : busy ? cast.busy : done ? (status === "done" ? "✅" : "💤") : cast.idle;
  const light = theme === "kitchen";
  return (
    <Link
      href={`/jobs/${t.job.id}`}
      data-wall-tile={t.n}
      data-href={`/jobs/${t.job.id}`}
      data-label={`${agent.id} · ${t.job.title.slice(0, 40)}`}
      className={`arcade-font relative flex flex-col items-center rounded-md border-2 px-1.5 pb-1.5 pt-6 text-center ${
        t.needsYou ? "arcade-glow border-[#fbbf24]" : failed ? "border-[#f87171]" : light ? "border-[#8a7f6e]" : "border-[#3a4558]"
      } ${done ? "opacity-55" : ""} ${light ? "bg-[#f7f3ea]/85 text-[#3b2a20]" : "bg-[#0f141c]/85 text-[#d6dae0]"}`}
      title={`${agent.id} (${agent.role}, ${agent.model}): ${agent.status}${t.say ? `\n${t.say}` : ""}`}
    >
      {t.n && <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] text-white">{t.n}</span>}
      <span className="absolute right-1 top-1 rounded px-1 text-[9px] font-bold text-black" style={{ background: badge.color }}>
        {badge.mark}
      </span>
      {/* Speech bubble: the agent's latest line. */}
      <div className={`arcade-bubble mb-1 min-h-[2.2em] w-full rounded px-1 py-0.5 text-[8px] leading-tight ${light ? "bg-white text-[#3b2a20]" : "bg-[#1f2937] text-[#e5e7eb]"}`}>
        {t.needsYou ? "Need you!" : t.say ? t.say.slice(0, 70) : busy ? "…" : ""}
      </div>
      <div className="relative h-14 w-full">
        <span className={`absolute left-1/2 top-0 -translate-x-1/2 text-3xl ${busy ? "arcade-work" : failed ? "arcade-shake" : t.needsYou ? "arcade-hop" : "arcade-sway"}`}>{cast.who}</span>
        <span className={`absolute -right-0 top-0 text-base ${busy || t.needsYou || failed ? "arcade-float" : ""}`}>{action}</span>
        <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-2xl">{failed && theme === "kitchen" ? "🔥" : cast.prop}</span>
      </div>
      <div className="mt-1 w-full truncate text-[9px] font-bold uppercase">{agent.id}</div>
      <div className="w-full truncate text-[8px] opacity-70">
        {agent.status.replace(/_/g, " ")} · {usd(agent.costUsd)}
      </div>
    </Link>
  );
}

const ARCADE_CSS = `
.arcade-font { font-family: ui-monospace, "Cascadia Mono", Menlo, monospace; letter-spacing: 0.02em; }
@keyframes arcade-work { 0%,100% { transform: translate(-50%, 0) } 50% { transform: translate(-50%, -3px) } }
@keyframes arcade-sway { 0%,100% { transform: translate(-50%, 0) rotate(-2deg) } 50% { transform: translate(-50%, 0) rotate(2deg) } }
@keyframes arcade-hop { 0%,100% { transform: translate(-50%, 0) } 40% { transform: translate(-50%, -8px) } }
@keyframes arcade-shake { 0%,100% { transform: translate(-50%, 0) } 25% { transform: translate(calc(-50% - 2px), 0) } 75% { transform: translate(calc(-50% + 2px), 0) } }
@keyframes arcade-float { 0% { transform: translateY(0); opacity: 1 } 100% { transform: translateY(-10px); opacity: 0.2 } }
@keyframes arcade-glow { 0%,100% { box-shadow: 0 0 0 0 #fbbf2400 } 50% { box-shadow: 0 0 14px 2px #fbbf24aa } }
.arcade-work { animation: arcade-work 0.45s steps(2) infinite; }
.arcade-sway { animation: arcade-sway 3s ease-in-out infinite; }
.arcade-hop { animation: arcade-hop 0.9s ease-in-out infinite; }
.arcade-shake { animation: arcade-shake 0.3s steps(2) infinite; }
.arcade-float { animation: arcade-float 1.2s ease-out infinite; }
.arcade-glow { animation: arcade-glow 1.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .arcade-work, .arcade-sway, .arcade-hop, .arcade-shake, .arcade-float, .arcade-glow { animation: none; } }
`;
