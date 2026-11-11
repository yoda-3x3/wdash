"use client";

import { useState } from "react";
import { usePoll } from "@/lib/client";

export type Skill = { name: string; description: string };

/** The skills agents have (published by the PC daemon). Shared by the /skills page and chat slash commands. */
export function useSkills(): Skill[] {
  const { data } = usePoll<{ skills: Skill[] }>("/api/skills", 10 * 60_000);
  return data?.skills ?? [];
}

/** What a chat message becomes when it starts with "/<skill>": the agent's slash command for that skill. */
export function expandSlash(text: string, skills: Skill[]): string {
  const m = text.match(/^\/([\w.-]+)(\s[\s\S]*)?$/);
  if (!m || !skills.some((s) => s.name === m[1])) return text;
  return `/skills:${m[1]}${m[2] ?? ""}`;
}

/** Like the CLI's /skills: every skill, searchable, with what it's for. */
export function SkillsPage() {
  const skills = useSkills();
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState("");
  const s = q.trim().toLowerCase();
  const shown = skills.filter((k) => !s || k.name.includes(s) || k.description.toLowerCase().includes(s));
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="flex items-baseline gap-3">
        <h1 className="text-lg font-semibold">/skills</h1>
        <span className="text-xs text-muted">{skills.length} skills every agent can use</span>
      </div>
      <p className="text-xs text-muted">
        Agents pick these up on their own when a task fits. To ask for one directly, start a chat message with <code>/name</code>, e.g. <code>/tdd add a test for the parser</code>. Typing <code>/</code> in a chat box lists them.
      </p>
      <input className="input" placeholder="Search skills…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {!skills.length && <p className="text-sm text-muted">No skills yet. They appear once the PC daemon has started with this version.</p>}
      <ul className="space-y-1">
        {shown.map((k) => (
          <li key={k.name}>
            <button
              type="button"
              className="card w-full px-3 py-2 text-left hover:border-accent"
              title="Copy the slash command"
              onClick={() => {
                void navigator.clipboard?.writeText(`/${k.name} `).catch(() => undefined);
                setCopied(k.name);
              }}
            >
              <span className="font-mono text-sm text-accent">/{k.name}</span>
              {copied === k.name && <span className="ml-2 text-xs text-muted">copied</span>}
              <span className="mt-0.5 block text-xs text-muted">{k.description || "No description."}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The "/" menu above a chat box: skills matching what's typed. Tab or click completes. */
export function SlashMenu({ text, skills, onPick }: { text: string; skills: Skill[]; onPick: (v: string) => void }) {
  const m = text.match(/^\/([\w.-]*)$/);
  if (!m) return null;
  const s = m[1]!.toLowerCase();
  const items = [{ name: "skills", description: "Show every skill (opens the Skills page)" }, ...skills]
    .filter((k) => k.name.startsWith(s) || (s.length > 1 && k.name.includes(s)))
    .slice(0, 8);
  if (!items.length) return null;
  return (
    <ul className="cc-slash max-h-64 overflow-y-auto rounded-lg border border-line bg-panel-2 p-1 text-xs" role="listbox">
      {items.map((k) => (
        <li key={k.name}>
          <button type="button" className="flex w-full gap-3 rounded px-2 py-1 text-left hover:bg-panel" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(`/${k.name} `)}>
            <span className="shrink-0 font-mono text-accent">/{k.name}</span>
            <span className="truncate text-muted">{k.description}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
