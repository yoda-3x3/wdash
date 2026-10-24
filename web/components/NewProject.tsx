"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProjectRequest } from "@wdash/shared";
import { api } from "@/lib/client";
import { useBoard } from "./Shell";

const LAST_PROJECT = "wdash:lastProject";

/** Asks the home PC to create a private GitHub repo, clone it, and register it as a project. */
export function NewProject() {
  const { state } = useBoard();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [buildCommand, setBuildCommand] = useState("");
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [req, setReq] = useState<ProjectRequest>();

  // Follow the request until the PC finishes it.
  useEffect(() => {
    if (!req || req.status === "done" || req.status === "failed") return;
    const t = setTimeout(async () => {
      try {
        setReq(await api<ProjectRequest>(`/api/projects/requests/${req.id}`));
      } catch (e) {
        setErr((e as Error).message);
      }
    }, 2000);
    return () => clearTimeout(t);
  }, [req]);

  useEffect(() => {
    if (req?.status !== "done" || !req.project) return;
    try {
      localStorage.setItem(LAST_PROJECT, req.project);
    } catch {
      /* storage blocked */
    }
  }, [req]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(undefined);
    try {
      setReq(
        await api<ProjectRequest>("/api/projects", {
          name: name.trim(),
          description: description.trim() || undefined,
          testCommand: testCommand.trim() || undefined,
          buildCommand: buildCommand.trim() || undefined,
          autoDeploy,
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (req) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <h1 className="text-lg font-semibold">New project: {req.input.name}</h1>
        <div className="card space-y-2 p-4 text-sm">
          {req.status === "pending" && (
            <p>{state?.home.online === false ? "Waiting for your PC to come online…" : "Waiting for your PC…"}</p>
          )}
          {req.status === "creating" && <p>Creating the GitHub repo and cloning it on your PC…</p>}
          {req.status === "failed" && <p className="text-bad">Couldn't create it: {req.error}</p>}
          {req.status === "done" && (
            <>
              <p className="text-ok">
                ✓ {req.repo ? `Created ${req.repo} on GitHub. It's ready to use.` : "Created a private repo and cloned it on your PC. It's ready to use."}
              </p>
              <p className="text-xs text-muted">
                {req.repo
                  ? "Jobs can run in the cloud right away; your PC clones it next time it's on, so PC runs work after that."
                  : "It runs on your PC and in the cloud."}
              </p>
              <div className="flex gap-2 pt-1">
                <Link href="/chat/new" className="btn btn-primary">
                  Start a chat
                </Link>
                <Link href="/new" className="btn">
                  Start a team job
                </Link>
              </div>
            </>
          )}
        </div>
        {req.status === "failed" && (
          <button className="btn" onClick={() => setReq(undefined)}>
            Back
          </button>
        )}
        {err && <p className="text-sm text-bad">{err}</p>}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-lg font-semibold">New project</h1>
      <p className="text-xs text-muted">
        Creates a private GitHub repo and adds it to your projects. It works even with your PC off; the PC clones it when it's back.
      </p>
      <Field label="Name">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. robot-arm" pattern="[A-Za-z0-9._\-]+" required autoFocus />
      </Field>
      <Field label="Description (optional)">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Test command (optional)">
          <input className="input font-mono" value={testCommand} onChange={(e) => setTestCommand(e.target.value)} placeholder="npm test" />
        </Field>
        <Field label="Build command (optional)">
          <input className="input font-mono" value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} placeholder="npm run build" />
        </Field>
      </div>
      <p className="text-xs text-muted">Agents can run the test and build commands without asking you, and reviews require them to pass.</p>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-1" checked={autoDeploy} onChange={(e) => setAutoDeploy(e.target.checked)} />
        <span>
          <span className="font-medium">▲ Auto-deploy to Vercel</span>
          <span className="block text-xs text-muted">
            When a job or chat in this project finishes, wdash deploys it to Vercel on its own and sends you the link. Agents can also deploy it without asking. Needs a Vercel token on the PC (see the README).
          </span>
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button className="btn btn-primary px-5 py-2" disabled={busy || !name.trim()}>
          {busy ? "Sending…" : "Create project"}
        </button>
        {state?.home.online === false && <span className="text-xs text-warn">Your PC is offline; it'll be created when it's back.</span>}
      </div>
      {err && <p className="text-sm text-bad">{err}</p>}
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
