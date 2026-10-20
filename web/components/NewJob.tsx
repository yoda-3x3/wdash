"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { MODEL_PRESETS, type ModelPreset, type ProjectConfig } from "@wdash/shared";
import { api, usePoll } from "@/lib/client";
import { useBoard } from "./Shell";
import { AttachButton, FileChips, dropProps, useUploads } from "./Attachments";

const LAST_PROJECT = "wdash:lastProject";

/** Hybrid form (SPEC.md §4): project + task up front, everything else under Advanced. */
export function NewJob() {
  const router = useRouter();
  const { state } = useBoard();
  const { data } = usePoll<{ projects: ProjectConfig[] }>("/api/projects", 60_000);
  const projects = data?.projects ?? [];

  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [workers, setWorkers] = useState("auto");
  const [models, setModels] = useState<ModelPreset>("opus-sonnet");
  const [runOn, setRunOn] = useState("auto");
  const [budget, setBudget] = useState("");
  const [reviewCap, setReviewCap] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const files = useUploads("/api/uploads");

  useEffect(() => {
    if (project || !projects.length) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT);
    } catch {
      /* storage blocked */
    }
    setProject(projects.find((p) => p.name === last)?.name ?? projects[0]!.name);
  }, [projects, project]);

  const selected = projects.find((p) => p.name === project);
  const online = state?.home.online;
  const where = runOn === "home" ? "your PC" : runOn === "cloud" ? "the cloud" : online ? "your PC" : "the cloud (PC is offline)";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !task.trim() || files.busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      try {
        localStorage.setItem(LAST_PROJECT, project);
      } catch {
        /* ignore */
      }
      const res = await api<{ id: string }>("/api/jobs", {
        project,
        task: task.trim(),
        workers,
        models,
        runOn,
        reviewCap,
        budgetUsd: budget ? Number(budget) : undefined,
        attachments: files.ready.map((f) => f.id),
      });
      router.push(`/jobs/${res.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (data && !projects.length) {
    return (
      <div className="card p-6 text-sm">
        <h1 className="mb-2 text-lg font-semibold">No projects yet</h1>
        <p className="text-muted">
          Add a project to <code>daemon/config/projects.json</code> on your PC and start the daemon once. It publishes the allowlist here.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4" {...dropProps(files.add)}>
      <h1 className="text-lg font-semibold">New job</h1>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Project</span>
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} required>
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} — {p.repo}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">What should the agents do?</span>
        <textarea
          className="input min-h-40 resize-y"
          placeholder="e.g. Fix the drag calculation in the sweep and add a regression test"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          required
          autoFocus
        />
      </label>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <AttachButton onFiles={files.add} />
          <span className="text-xs text-muted">Docs, PDFs, images, data… up to 4 MB each. Or drop them here.</span>
        </div>
        <FileChips items={files.items} onRemove={files.remove} />
      </div>

      <button type="button" className="text-sm text-accent" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "▾" : "▸"} Advanced
      </button>
      {advanced && (
        <div className="card grid gap-3 p-3 sm:grid-cols-2">
          <Field label="Workers">
            <select className="input" value={workers} onChange={(e) => setWorkers(e.target.value)}>
              <option value="auto">Auto (orchestrator decides, 1–4)</option>
              {["1", "2", "3", "4"].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Models">
            <select className="input" value={models} onChange={(e) => setModels(e.target.value as ModelPreset)}>
              {Object.entries(MODEL_PRESETS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Run on">
            <select className="input" value={runOn} onChange={(e) => setRunOn(e.target.value)}>
              <option value="auto">Auto (PC if online)</option>
              <option value="home">PC only (wait if offline)</option>
              <option value="cloud" disabled={selected && !selected.cloud}>
                Cloud
              </option>
            </select>
          </Field>
          <Field label={`Budget, API-equivalent $ (default ${selected?.defaultBudgetUsd ?? 5})`}>
            <input className="input" inputMode="decimal" placeholder={String(selected?.defaultBudgetUsd ?? 5)} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </Field>
          <Field label="Review rounds per worker before asking you">
            <input className="input" type="number" min={1} max={10} value={reviewCap} onChange={(e) => setReviewCap(Number(e.target.value))} />
          </Field>
        </div>
      )}

      <div className="flex items-center gap-3">
        <button className="btn btn-primary px-5 py-2" disabled={busy || files.busy || !project || !task.trim()}>
          {busy ? "Starting…" : files.busy ? "Uploading…" : "Start"}
        </button>
        <span className="text-xs text-muted">Runs on {where}.</span>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
