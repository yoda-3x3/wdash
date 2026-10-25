import { hostname } from "node:os";
import { K, NO_PROJECT, TERMINAL_STATUSES, scratchProject, type ProjectConfig } from "@wdash/shared";
import { loadLocalProjects } from "./config.js";
import { pushBase, syncIntoCheckout } from "./git.js";
import { JobRunner } from "./job.js";
import { clear, raise } from "./notify.js";
import { processProjectRequests } from "./projects.js";
import { Relay } from "./relay.js";

const MAX_CONCURRENT_JOBS = 3;
const HOLDER = "home";

/** Long-running daemon on the user's PC. SPEC.md §3. */
export async function runHome(): Promise<void> {
  const relay = new Relay();
  let projects = loadLocalProjects();
  if (!projects.length) console.warn("No projects in config/projects.json — nothing can run until you add one.");
  await relay.publishProjects(projects);
  console.log(`wdash home daemon: ${projects.length} project(s): ${projects.map((p) => p.name).join(", ") || "-"}`);

  const running = new Map<string, Promise<unknown>>();
  let stopping = false;

  const heartbeat = async () => {
    try {
      await relay.heartbeatHome();
    } catch (e) {
      console.error("heartbeat failed", (e as Error).message);
    }
  };
  await heartbeat();
  const hb = setInterval(heartbeat, 10_000);

  const startJob = async (jobId: string) => {
    if (running.has(jobId)) return;
    const job = await relay.getJob(jobId);
    if (!job || TERMINAL_STATUSES.includes(job.status)) return;
    projects = loadLocalProjects();
    // A chat without a project runs in a scratch folder, not a checkout.
    const project = job.project === NO_PROJECT ? scratchProject() : projects.find((p) => p.name === job.project);
    if (!project || (job.project !== NO_PROJECT && !project.localPath)) {
      await relay.setStatus(jobId, "failed", { error: `Project '${job.project}' isn't in the home daemon's allowlist.` });
      await raise(relay, "job_failed", { jobId, detail: `Project '${job.project}' isn't allowlisted on the PC.` });
      return;
    }
    const runner = new JobRunner(relay, jobId, project, "home", project.localPath ?? "", HOLDER);
    console.log(`[${jobId}] starting on home PC`);
    const p = runner
      .run()
      .then((o) => console.log(`[${jobId}] ended: ${o}`))
      .catch((e) => console.error(`[${jobId}] crashed`, e))
      .finally(() => running.delete(jobId));
    running.set(jobId, p);
  };

  // Jobs that were running here before a restart and haven't been migrated yet.
  for (const id of await relay.r.zrevrange(K.jobs, 0, 200)) {
    const job = await relay.getJob(id);
    if (!job || TERMINAL_STATUSES.includes(job.status) || job.location !== "home") continue;
    const lease = await relay.r.get(K.lease(id));
    if (!lease || lease === HOLDER) await startJob(id);
  }

  const sync = async () => {
    try {
      await syncFinishedJobs(relay, loadLocalProjects());
    } catch (e) {
      console.error("sync failed", e);
    }
  };
  await sync();
  const syncTimer = setInterval(sync, 5 * 60_000);

  // "New project" requests from the dashboard (one at a time; gh does the GitHub side).
  let creating = false;
  const projectTimer = setInterval(async () => {
    if (creating) return;
    creating = true;
    try {
      if (await processProjectRequests(relay)) projects = loadLocalProjects();
      // "Ping PC" from the dashboard: answer with what this daemon is doing.
      for (let id = await relay.r.lpop(K.pingQueue); id; id = await relay.r.lpop(K.pingQueue)) {
        const pong = { at: Date.now(), uptimeSec: Math.round(process.uptime()), jobs: running.size, projects: projects.length, host: hostname() };
        await relay.r.set(K.pong(id), JSON.stringify(pong), "EX", 60);
      }
    } catch (e) {
      console.error("project requests failed", (e as Error).message);
    } finally {
      creating = false;
    }
  }, 3000);

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("shutting down…");
    clearInterval(hb);
    clearInterval(syncTimer);
    clearInterval(projectTimer);
    await relay.r.del(K.homeHeartbeat).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopping) {
    if (running.size >= MAX_CONCURRENT_JOBS || (await relay.isPaused().catch(() => false))) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    let jobId: string | undefined;
    try {
      jobId = await relay.popHomeJob(5);
    } catch (e) {
      console.error("queue read failed", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (jobId) await startJob(jobId);
  }
}

/** Merge finished cloud jobs into the PC's checkouts (SPEC.md §10, sync on wake). */
export async function syncFinishedJobs(relay: Relay, projects: ProjectConfig[]): Promise<void> {
  const ids = await relay.r.zrange(K.mergeQueue, "0", "-1");
  for (const id of ids) {
    const job = await relay.getJob(id);
    if (!job || (job.mergeState !== "pending" && job.mergeState !== "merged")) {
      await relay.r.zrem(K.mergeQueue, id);
      continue;
    }
    const project = projects.find((p) => p.name === job.project);
    if (!project?.localPath) {
      if (job.mergeState === "merged") await relay.r.zrem(K.mergeQueue, id); // nothing on the PC to update
      continue;
    }
    const out = await syncIntoCheckout(project.localPath, project.baseBranch, id);
    if (out.kind === "missing") continue; // not pushed yet; try again later
    await relay.r.zrem(K.mergeQueue, id);
    if (job.mergeState === "merged") {
      // Already merged on GitHub; this only brought the PC checkout up to date (if it was clean).
      if (out.kind === "merged") await relay.emit({ jobId: id, type: "info", payload: { text: `Your PC's ${project.baseBranch} is up to date with it (${out.sha.slice(0, 8)}).` } });
      continue;
    }
    if (out.kind === "merged") {
      await relay.updateJob(id, { mergeState: "merged" });
      await relay.emit({ jobId: id, type: "info", payload: { text: `Merged into ${project.baseBranch} on your PC (${out.sha.slice(0, 8)}).` } });
      if (project.pushOnMerge) {
        const err = await pushBase(project.localPath, project.baseBranch);
        await relay.emit({
          jobId: id,
          type: "info",
          payload: { text: err ? `Couldn't push ${project.baseBranch} to GitHub: ${err}` : `Pushed ${project.baseBranch} to GitHub (${project.repo}).` },
        });
      }
      await clear(relay, id, "needs_merge");
    } else {
      await relay.updateJob(id, { mergeState: "needs_merge" });
      await raise(relay, "needs_merge", {
        jobId: id,
        detail: `${out.why}${out.conflicts?.length ? ` Conflicts: ${out.conflicts.join(", ")}` : ""} The work is on branch wdash/${id}/main.`,
      });
    }
  }
}
