"use client";

import { useState } from "react";
import type { CacheEntry, ProjectConfig } from "@wdash/shared";
import { api, timeAgo, usePoll } from "@/lib/client";

type Draft = { id: string; title: string; body: string; scope: string; links: string };
const EMPTY: Draft = { id: "", title: "", body: "", scope: "all", links: "" };
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

/**
 * Settings > Worker cache: notes every agent gets as a short index at start and reads in full with cache_read, so
 * workers on any model skip rediscovering things. Agents add their own findings with cache_write.
 */
export function WorkerCache() {
  const { data, refresh } = usePoll<{ entries: CacheEntry[] }>("/api/cache", 60_000);
  const { data: proj } = usePoll<{ projects: ProjectConfig[] }>("/api/projects", 5 * 60_000);
  const [draft, setDraft] = useState<Draft>();
  const [open, setOpen] = useState<string>();
  const [err, setErr] = useState<string>();
  const [busy, setBusy] = useState(false);
  const entries = data?.entries ?? [];

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(undefined);
    try {
      const links = draft.links.split(/\s+/).map((l) => l.trim()).filter(Boolean);
      await api("/api/cache", { id: draft.id || slug(draft.title), title: draft.title, body: draft.body, scope: draft.scope, links });
      setDraft(undefined);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!confirm(`Delete "${id}" from the worker cache?`)) return;
    await api(`/api/cache?id=${encodeURIComponent(id)}`, undefined, "DELETE");
    refresh();
  }

  return (
    <div className="space-y-4">
      <section className="card space-y-2 p-4 text-sm">
        <div className="flex items-center gap-2">
          <h2 className="font-medium">Worker cache</h2>
          <button className="btn btn-primary ml-auto" onClick={() => setDraft({ ...EMPTY })}>
            + New entry
          </button>
        </div>
        <p className="text-xs text-muted">
          Shared notes for every agent, on any model: how a project builds, where things live, how to drive a tool, links worth reading (docs, datasets). Each
          agent starts with a short index and reads the entries it needs, so it spends fewer tokens rediscovering them. Agents save what they learn here too.
        </p>
      </section>

      {draft && (
        <section className="card space-y-2 p-4 text-sm">
          <input className="input" placeholder="Title, e.g. Blender: rendering a flyover" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          <div className="flex flex-wrap gap-2">
            <input
              className="input sm:w-56"
              placeholder={`id (${slug(draft.title) || "auto from title"})`}
              value={draft.id}
              onChange={(e) => setDraft({ ...draft, id: slug(e.target.value) })}
            />
            <select className="input sm:w-56" value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })}>
              <option value="all">All projects</option>
              {(proj?.projects ?? []).map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} only
                </option>
              ))}
            </select>
          </div>
          <textarea className="input min-h-40 font-mono text-xs" placeholder="Notes (markdown)" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
          <textarea
            className="input min-h-16 font-mono text-xs"
            placeholder="Links, one per line (docs, Hugging Face datasets, references). Agents read them with WebFetch."
            value={draft.links}
            onChange={(e) => setDraft({ ...draft, links: e.target.value })}
          />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy || !draft.title.trim()} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button className="btn" onClick={() => setDraft(undefined)}>
              Cancel
            </button>
          </div>
          {err && <p className="text-xs text-bad">{err}</p>}
        </section>
      )}

      {!data ? (
        <p className="text-sm text-muted">…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-muted">Empty. Add notes, or let agents fill it as they work.</p>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => (
            <li key={e.id} className="card p-3 text-sm">
              <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(open === e.id ? undefined : e.id)}>
                <span className="font-medium">{e.title}</span>
                <span className="rounded border border-line px-1.5 text-[11px] text-muted">{e.scope === "all" ? "all projects" : e.scope}</span>
                <span className="ml-auto text-xs text-muted">
                  {e.by === "you" ? "you" : e.by} · {timeAgo(e.updatedAt)}
                </span>
              </button>
              {open === e.id && (
                <div className="mt-2 space-y-2">
                  <div className="font-mono text-[11px] text-muted">id: {e.id}</div>
                  {e.body && <pre className="whitespace-pre-wrap break-words rounded bg-panel-2 p-2 text-xs">{e.body}</pre>}
                  {e.links.length > 0 && (
                    <ul className="space-y-0.5 text-xs">
                      {e.links.map((l) => (
                        <li key={l}>
                          <a href={l} target="_blank" rel="noreferrer" className="break-all text-accent hover:underline">
                            {l}
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button className="btn px-2 py-0.5 text-xs" onClick={() => setDraft({ id: e.id, title: e.title, body: e.body, scope: e.scope, links: e.links.join("\n") })}>
                      Edit
                    </button>
                    <button className="btn px-2 py-0.5 text-xs text-bad" onClick={() => remove(e.id)}>
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
