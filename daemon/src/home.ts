import { hostname } from "node:os";
import { K, KaggleControl, NO_PROJECT, TERMINAL_STATUSES, scratchProject, type ProjectConfig } from "@wdash/shared";
import { loadLocalProjects } from "./config.js";
import { pushBase, syncIntoCheckout } from "./git.js";
import { JobRunner } from "./job.js";
import { handleKaggleControl, liveKaggleServers } from "./kaggle.js";
import { clear, raise } from "./notify.js";
import { processProjectRequests } from "./projects.js";
import { checkQuotas } from "./quota.js";
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
  const hb = setInterval(heartbeat, 60_000);

  const startJob = async (jobId: string) => {
    if (running.has(jobId)) return;
    const job = await relay.getJob(jobId);
    if (!job || TERMINAL_STATUSES.includes(job.status)) return;
    projects = loadLocalProjects();
    // A repo picked on the website a moment ago may not be cloned here yet: handle pending project requests first.
    if (job.project !== NO_PROJECT && !projects.some((p) => p.name === job.project)) {
      if (await processProjectRequests(relay).catch(() => 0)) projects = loadLocalProjects();
    }
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
    // Notices Kaggle servers that idled off, so their GPU time is counted on the usage panel.
    await liveKaggleServers(relay).catch((e) => console.error("kaggle check failed", (e as Error).message));
    await checkQuotas(relay).catch((e) => console.error("quota check failed", (e as Error).message));
  };
  await sync();
  const syncTimer = setInterval(sync, 5 * 60_000);

  // "New project" requests from the dashboard, one at a time (gh does the GitHub side), off the main loop.
  let creating: Promise<unknown> = Promise.resolve();
  const createProjects = (first: string) => {
    creating = creating.then(async () => {
      try {
        if (await processProjectRequests(relay, first)) projects = loadLocalProjects();
      } catch (e) {
        console.error("project requests failed", (e as Error).message);
      }
    });
  };
  // "Ping PC" from the dashboard: answer with what this daemon is doing.
  const pong = async (id: string) => {
    const p = { at: Date.now(), uptimeSec: Math.round(process.uptime()), jobs: running.size, projects: projects.length, host: hostname() };
    await relay.r.set(K.pong(id), JSON.stringify(p), "EX", 60);
  };

  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log("shutting down…");
    clearInterval(hb);
    clearInterval(syncTimer);
    await relay.r.del(K.homeHeartbeat).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // One blocking wait for jobs, project requests and pings: about one request a minute while idle.
  while (!stopping) {
    // Paused or at the job cap: leave jobs queued, but keep answering pings and project requests.
    const full = running.size >= MAX_CONCURRENT_JOBS || (await relay.isPaused().catch(() => false));
    let next: { queue: string; id: string } | undefined;
    try {
      next = await relay.popHomeWork(full ? 30 : 60, !full);
    } catch (e) {
      console.error("queue read failed", (e as Error).message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!next) continue;
    if (next.queue === K.projectQueue) createProjects(next.id);
    // Start/Stop from the website; a start takes minutes, so it runs off the loop.
    else if (next.queue === K.kaggleQueue) {
      let raw: unknown;
      try {
        raw = JSON.parse(next.id);
      } catch {
        /* not ours */
      }
      const ctl = KaggleControl.safeParse(raw);
      if (ctl.success) void handleKaggleControl(relay, ctl.data);
    }
    else if (next.queue === K.pingQueue) await pong(next.id).catch((e) => console.error("ping failed", (e as Error).message));
    // Paused while we were waiting: put the job back where it was (next in line).
    else if (await relay.isPaused().catch(() => false)) await relay.r.rpush(K.homeQueue, next.id);
    else await startJob(next.id);
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
