"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  KAGGLE_MODELS,
  MAX_WORKERS,
  MODEL_PRESETS,
  NO_PROJECT,
  WORKER_CHOICES,
  presetLabel,
  type ChatModel,
  type JobKind,
  type ModelPreset,
  type ProjectConfig,
  type TeamShape,
} from "@wdash/shared";
import { api, usePoll } from "@/lib/client";
import { useBoard } from "./Shell";
import { AttachButton, FileChips, dropProps, useUploads } from "./Attachments";
import { PREFS } from "./Home";

const LAST_PROJECT = "wdash:lastProject";
/** Project select value for a GitHub repo that isn't a project yet. */
const REPO_PREFIX = "repo:";
const AUTO_MODE = "wdash:autoMode";

const CHAT_MODELS: Record<ChatModel, string> = { sonnet: "Sonnet", opus: "Opus", haiku: "Haiku", kaggle: "Kaggle GPU (open model, PC only)" };

/** Hybrid form (SPEC.md §4): project + task up front, everything else under Advanced. Also starts chats. */
export function NewJob({ kind = "team" }: { kind?: JobKind }) {
  const chat = kind === "chat";
  const router = useRouter();
  const { state } = useBoard();
  const { data } = usePoll<{ projects: ProjectConfig[] }>("/api/projects", 60_000);
  const projects = data?.projects ?? [];
  // Every GitHub repo you have, so any of them can be picked; choosing one adopts it as a project on Start.
  const { data: repoData } = usePoll<{ repos: Array<{ repo: string; private: boolean }> }>("/api/github/repos", 10 * 60_000);
  const known = new Set(projects.map((p) => p.repo.toLowerCase()));
  const otherRepos = (repoData?.repos ?? []).filter((r) => !known.has(r.repo.toLowerCase()));

  const [project, setProject] = useState("");
  const [task, setTask] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [workers, setWorkers] = useState("auto");
  const [shape, setShape] = useState<TeamShape>("auto");
  const [models, setModels] = useState<ModelPreset>("sonnet-haiku");
  const [chatModel, setChatModel] = useState<ChatModel>("sonnet");
  const [kaggleModel, setKaggleModel] = useState(KAGGLE_MODELS[0]!.id);
  const kaggle = chat ? chatModel === "kaggle" : models === "kaggle";
  const [autoMode, setAutoMode] = useState(false);
  const [lite, setLite] = useState(false);

  useEffect(() => {
    try {
      setAutoMode(localStorage.getItem(AUTO_MODE) !== "0"); // on unless turned off
      setLite(localStorage.getItem(PREFS.lite) === "1");
    } catch {
      /* storage blocked */
    }
  }, []);
  const [runOn, setRunOn] = useState("auto");
  const [budget, setBudget] = useState("");
  const [reviewCap, setReviewCap] = useState(3);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const files = useUploads("/api/uploads");

  useEffect(() => {
    if (project) return;
    if (!projects.length) {
      if (chat && data) setProject(NO_PROJECT);
      return;
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT);
    } catch {
      /* storage blocked */
    }
    setProject(projects.find((p) => p.name === last)?.name ?? projects[0]!.name);
  }, [projects, project, chat, data]);

  const selected = projects.find((p) => p.name === project);
  const online = state?.home.online;
  const where = runOn === "home" ? "your PC" : runOn === "cloud" ? "the cloud" : online ? "your PC" : "the cloud (PC is offline)";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!project || !task.trim() || files.busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      // A repo from "Your GitHub repos": make it a project first (cloud-ready now, the PC clones it).
      let projectName = project;
      if (project.startsWith(REPO_PREFIX)) {
        const adopted = await api<{ project: string }>("/api/projects/adopt", { repo: project.slice(REPO_PREFIX.length) });
        projectName = adopted.project;
      }
      try {
        localStorage.setItem(LAST_PROJECT, projectName);
        localStorage.setItem(AUTO_MODE, autoMode ? "1" : "0");
        localStorage.setItem(PREFS.lite, lite ? "1" : "0");
      } catch {
        /* ignore */
      }
      const res = await api<{ id: string }>("/api/jobs", {
        project: projectName,
        task: task.trim(),
        kind,
        chatModel,
        workers,
        shape,
        models,
        kaggleModel: kaggle ? kaggleModel : "",
        // The Kaggle server is driven from the PC.
        runOn: kaggle ? "home" : runOn,
        reviewCap,
        autoMode,
        lite,
        budgetUsd: budget ? Number(budget) : undefined,
        attachments: files.ready.map((f) => f.id),
      });
      router.push(`/jobs/${res.id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  }

  if (data && !projects.length && !chat) {
    return (
      <div className="card p-6 text-sm">
        <h1 className="mb-2 text-lg font-semibold">No projects yet</h1>
        <p className="text-muted">
          <Link href="/projects/new" className="text-accent">Create a project</Link>, or add one to <code>daemon/config/projects.json</code> on your PC and start the daemon once. It publishes the allowlist here.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4" {...dropProps(files.add)}>
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">{chat ? "New chat" : "New job"}</h1>
        <div className="ml-auto flex rounded-lg border border-line p-0.5 text-sm">
          <Link href="/new" className={`rounded-md px-3 py-1 ${chat ? "text-muted" : "bg-panel-2 font-medium"}`}>
            Team job
          </Link>
          <Link href="/chat/new" className={`rounded-md px-3 py-1 ${chat ? "bg-panel-2 font-medium" : "text-muted"}`}>
            Chat
          </Link>
        </div>
      </div>
      <p className="text-xs text-muted">
        {chat
          ? "Talk with one Claude in the project's repo. It can edit files; Finish & merge brings its changes into your PC's copy."
          : "An orchestrator plans the work, workers do it in parallel, and every change is reviewed and tested before merging."}
      </p>
      <label className="block space-y-1">
        <span className="flex items-center text-sm font-medium">
          Project
          <Link href="/projects/new" className="ml-auto text-xs font-normal text-accent">
            + New project
          </Link>
        </span>
        <select className="input" value={project} onChange={(e) => setProject(e.target.value)} required>
          {chat && <option value={NO_PROJECT}>No project (just chat)</option>}
          {projects.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name} — {p.repo}
            </option>
          ))}
          {otherRepos.length > 0 && (
            <optgroup label="Your GitHub repos">
              {otherRepos.map((r) => (
                <option key={r.repo} value={`${REPO_PREFIX}${r.repo}`}>
                  {r.repo}
                  {r.private ? " 🔒" : ""}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {project.startsWith(REPO_PREFIX) && (
          <span className="block text-xs text-muted">Not a project yet: Start adds it, and your PC clones it before running.</span>
        )}
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">{chat ? "Your first message" : "What should the agents do?"}</span>
        <textarea
          className={`input resize-y ${chat ? "min-h-28" : "min-h-40"}`}
          placeholder={chat ? "e.g. Walk me through how the solver works" : "e.g. Fix the drag calculation in the sweep and add a regression test"}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          required
          autoFocus
        />
      </label>
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <AttachButton onFiles={files.add} />
          <span className="text-xs text-muted">Docs, PDFs, images, data… up to 90 MB each. Or drop them here.</span>
        </div>
        <FileChips items={files.items} onRemove={files.remove} />
      </div>
      {chat && (
        <Field label="Model">
          <select className="input sm:w-56" value={chatModel} onChange={(e) => setChatModel(e.target.value as ChatModel)}>
            {Object.entries(CHAT_MODELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      )}
      {chat && kaggle && <KaggleModelField value={kaggleModel} onChange={setKaggleModel} />}

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={autoMode} onChange={(e) => setAutoMode(e.target.checked)} />
        <span>
          <span className="font-medium">⚡ Auto mode</span>
          <span className="block text-xs text-muted">
            Approve permission requests (shell commands, web fetches) automatically. Agents still can't touch anything outside the job's folder, and questions still come to you. You can switch it on or off while the job runs.
          </span>
        </span>
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={lite} onChange={(e) => setLite(e.target.checked)} />
        <span>
          <span className="font-medium">🪶 Low usage mode</span>
          <span className="block text-xs text-muted">
            Uses as few tokens as possible: a minimal tool set (no subagents or web tools), low effort, short prompts{chat ? "" : ", one worker unless the task really splits, and one review round"}. Best for small, well-defined tasks.
          </span>
        </span>
      </label>

      <button type="button" className="text-sm text-accent" onClick={() => setAdvanced((v) => !v)}>
        {advanced ? "▾" : "▸"} Advanced
      </button>
      {advanced && (
        <div className="card grid gap-3 p-3 sm:grid-cols-2">
          {!chat && (
            <>
              <Field label="Workers">
                <select className="input" value={workers} onChange={(e) => setWorkers(e.target.value)}>
                  <option value="auto">Auto (orchestrator decides, 1–{MAX_WORKERS})</option>
                  {WORKER_CHOICES.slice(1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Team shape">
                <select className="input" value={shape} onChange={(e) => setShape(e.target.value as TeamShape)}>
                  <option value="auto">Auto (orchestrator decides)</option>
                  <option value="three-tier">3 tiers: orchestrator → leads → workers</option>
                </select>
              </Field>
              <Field label={shape === "three-tier" ? "Models (orchestrator → leads → workers)" : "Models"}>
                <select className="input" value={models} onChange={(e) => setModels(e.target.value as ModelPreset)}>
                  {(Object.keys(MODEL_PRESETS) as ModelPreset[]).map((k) => (
                    <option key={k} value={k}>
                      {presetLabel(k, shape)}
                    </option>
                  ))}
                </select>
              </Field>
              {kaggle && <KaggleModelField value={kaggleModel} onChange={setKaggleModel} />}
            </>
          )}
          <Field label="Run on">
            <select className="input" value={kaggle ? "home" : runOn} disabled={kaggle} onChange={(e) => setRunOn(e.target.value)}>
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
          {!chat && (
            <Field label="Review rounds per worker before asking you">
              <input className="input" type="number" min={1} max={10} value={lite ? 1 : reviewCap} disabled={lite} onChange={(e) => setReviewCap(Number(e.target.value))} />
            </Field>
          )}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button className="btn btn-primary px-5 py-2" disabled={busy || files.busy || !project || !task.trim()}>
          {busy ? "Starting…" : files.busy ? "Uploading…" : chat ? "Start chat" : "Start"}
        </button>
        <span className="text-xs text-muted">Runs on {where}.</span>
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
    </form>
  );
}

function KaggleModelField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Kaggle model (every agent uses it)">
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        {KAGGLE_MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
    </Field>
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
