import { resolve } from "node:path";
import { JobRunner } from "./job.js";
import { raise } from "./notify.js";
import { Relay } from "./relay.js";

/** Runs one job on a GitHub Actions runner (SPEC.md §3). Exits when the job ends. */
export async function runCloud(jobId: string, repoDir: string): Promise<number> {
  const relay = new Relay();
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  const holder = `cloud:${runId}`;
  try {
    const job = await relay.getJob(jobId);
    if (!job) throw new Error(`job ${jobId} not found`);
    if (job.runOn === "home") {
      console.log("The user chose to wait for the PC; exiting.");
      return 0;
    }
    const project = await relay.getProject(job.project);
    if (!project) throw new Error(`project ${job.project} isn't published; start the home daemon once to publish projects`);

    const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}`
      : undefined;
    await relay.updateJob(jobId, { cloudRunUrl: runUrl });
    await relay.heartbeatCloud(jobId);

    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN secret is missing in this repo");

    const runner = new JobRunner(relay, jobId, project, "cloud", resolve(repoDir), holder, { CLAUDE_CODE_OAUTH_TOKEN: token });
    const outcome = await runner.run();
    console.log(`job ${jobId} ended: ${outcome}`);
    if (outcome === "lost_lease") console.log("Another runner holds this job (probably the home PC came back).");
    return 0;
  } catch (e) {
    const msg = (e as Error).message;
    console.error(msg);
    await relay.setStatus(jobId, "failed", { error: msg }).catch(() => undefined);
    await raise(relay, "job_failed", { jobId, detail: `Cloud runner error: ${msg}` }).catch(() => undefined);
    return 1;
  } finally {
    await relay.close().catch(() => undefined);
  }
}
