import { K, NO_PROJECT, TERMINAL_STATUSES, type JobRecord } from "@wdash/shared";
import { raise, clear } from "./attention";
import { dispatchCloudRun } from "./github";
import { redis } from "./redis";
import { emit, getProject, homeOnline, listJobs, updateJob } from "./relay";

// SPEC.md §3 + §10: where a job runs, and moving it to the cloud when the PC disappears.

const CLOUD_START_GRACE_MS = 10 * 60_000;
const HOME_PICKUP_GRACE_MS = 60_000;

export async function placeJob(job: JobRecord, opts: { forceCloud?: boolean } = {}): Promise<void> {
  const project = await getProject(job.project);
  if (!project) throw new Error(`Unknown project ${job.project}`);
  const { online } = await homeOnline();
  const wantCloud = opts.forceCloud || job.runOn === "cloud" || (job.runOn === "auto" && !online);

  if (!wantCloud || !project.cloud) {
    await redis().lrem(K.homeQueue, 0, job.id);
    await redis().lpush(K.homeQueue, job.id);
    await updateJob(job.id, { location: online ? "home" : "queued", status: "queued" });
    await emit(job.id, "info", { text: online ? "Queued on your PC." : "Waiting for your PC to come online." });
    return;
  }
  await dispatch(job, project.name === NO_PROJECT ? "" : project.repo);
}

async function dispatch(job: JobRecord, repo: string, migrating = false): Promise<void> {
  await redis().lrem(K.homeQueue, 0, job.id);
  try {
    // Runs wdash-cloud.yml in the wdash repo, which checks out the project; the daemon handles job branches.
    await dispatchCloudRun(repo, job.id);
    await updateJob(job.id, { location: migrating ? "migrating" : "cloud", dispatchedAt: Date.now() });
    await emit(job.id, "info", { text: migrating ? "PC went offline. Resuming on a cloud runner…" : "Starting a cloud runner…" });
    await clear(job.id, "cloud_dispatch_failed");
  } catch (e) {
    await updateJob(job.id, { location: "queued" });
    await raise("cloud_dispatch_failed", { jobId: job.id, detail: (e as Error).message });
  }
}

/**
 * Detect stranded jobs and fix them. Runs on board polls (throttled) and from an external cron,
 * because Vercel Hobby crons only fire daily.
 */
export async function reconcile(force = false): Promise<void> {
  const r = redis();
  if (!force) {
    const got = await r.set("wd:reconcile:lock", "1", { ex: 20, nx: true });
    if (!got) return;
  }
  const { online } = await homeOnline();
  const jobs = (await listJobs(100)).filter((j) => !TERMINAL_STATUSES.includes(j.status) && !j.archived);
  const now = Date.now();

  for (const job of jobs) {
    const lease = await r.get<string>(K.lease(job.id));
    if (lease) continue; // someone is running it
    const project = await getProject(job.project);
    if (!project) continue;

    if (job.location === "home" && job.status !== "queued") {
      // Was running on the PC; the lease expired and the PC is gone.
      if (online) continue; // PC is up, it will resume the job itself
      if (job.runOn === "home" || !project.cloud) {
        await raise("pc_offline", { jobId: job.id, detail: "This job is set to run on your PC, so it will continue when the PC is back." });
        await updateJob(job.id, { location: "queued" });
        continue;
      }
      await raise("pc_offline", { jobId: job.id, detail: `Resuming from checkpoint ${job.lastCheckpointSha?.slice(0, 8) ?? "(start)"} on a cloud runner.` });
      await dispatch(job, project.name === NO_PROJECT ? "" : project.repo, true);
      continue;
    }

    if ((job.location === "home" || job.location === "queued") && job.status === "queued") {
      // Queued for the PC but nobody picked it up.
      if (online || job.runOn === "home" || !project.cloud) continue;
      if (now - job.updatedAt < HOME_PICKUP_GRACE_MS) continue;
      await dispatch(job, project.name === NO_PROJECT ? "" : project.repo);
      continue;
    }

    if (job.location === "cloud" || job.location === "migrating") {
      const hb = await r.get<string>(K.cloudHeartbeat(job.id));
      if (hb) continue;
      if (job.dispatchedAt && now - job.dispatchedAt < CLOUD_START_GRACE_MS) continue;
      await updateJob(job.id, { location: "queued" });
      await raise("cloud_dispatch_failed", {
        jobId: job.id,
        detail: job.cloudRunUrl ? `The cloud runner stopped unexpectedly. Logs: ${job.cloudRunUrl}` : "The cloud runner never started (check the wdash repo's Actions tab and secrets).",
      });
    }
  }
}

/** Re-queue a job whose runner is gone (resume after failure, retry dispatch, run on PC). */
export async function requeue(job: JobRecord, how: "auto" | "cloud" | "home"): Promise<void> {
  if (how === "home") {
    await updateJob(job.id, { runOn: "home" });
    job = { ...job, runOn: "home" };
  }
  await updateJob(job.id, { status: "queued" });
  await placeJob({ ...job, status: "queued" }, { forceCloud: how === "cloud" });
}
