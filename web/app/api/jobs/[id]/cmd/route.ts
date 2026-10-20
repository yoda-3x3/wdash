import { NextResponse } from "next/server";
import { z } from "zod";
import { Command, K, TERMINAL_STATUSES, branchFor } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { clear, clearAllForJob } from "@/lib/attention";
import { deleteBranch, listBranches } from "@/lib/github";
import { requeue } from "@/lib/placement";
import { redis } from "@/lib/redis";
import { archiveJob } from "@/lib/archive";
import { emit, getJob, getProject, listFiles, pushCommand, setStatus, updateJob } from "@/lib/relay";

const Body = z.union([
  z.object({ cmd: Command }),
  z.object({ webAction: z.enum(["merge", "leave_branch", "discard", "retry_dispatch", "run_home", "archive", "cancel_migration"]) }),
]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { id } = await params;
  const parsed = Body.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const live = !!(await redis().get(K.lease(id)));

  if ("webAction" in parsed.data) {
    const project = await getProject(job.project);
    switch (parsed.data.webAction) {
      case "leave_branch":
        await updateJob(id, { mergeState: "left_as_branch" });
        await clear(id, "needs_merge");
        await emit(id, "info", { text: `Left as branch ${branchFor.main(id)}.` });
        break;
      case "discard":
        if (project) for (const b of await listBranches(project.repo, `wdash/${id}/`)) await deleteBranch(project.repo, b);
        await updateJob(id, { mergeState: "discarded" });
        await clear(id, "needs_merge");
        await emit(id, "info", { text: "Discarded the job's branches on GitHub." });
        break;
      case "retry_dispatch":
        await clear(id, "cloud_dispatch_failed");
        await requeue(job, "cloud");
        break;
      case "run_home":
        await clear(id, "cloud_dispatch_failed");
        await requeue(job, "home");
        break;
      case "cancel_migration":
        // Keep the job for the PC; a cloud runner that starts later sees runOn=home and exits.
        await updateJob(id, { runOn: "home", location: "queued" });
        await clear(id, "pc_offline");
        await redis().lrem(K.homeQueue, 0, id);
        await redis().lpush(K.homeQueue, id);
        await emit(id, "info", { text: "Waiting for your PC instead of the cloud." });
        break;
      case "archive":
        await archiveJob(id);
        break;
      case "merge":
        return NextResponse.json({ error: "Resolve the merge on your PC, then choose Leave as branch." }, { status: 400 });
    }
    return NextResponse.json({ ok: true });
  }

  const cmd = parsed.data.cmd;
  if (cmd.type === "user_message" && cmd.attachments?.length) {
    const known = new Set((await listFiles(id)).map((f) => f.id));
    if (!cmd.attachments.every((f) => known.has(f))) return NextResponse.json({ error: "Unknown attachment." }, { status: 400 });
  }
  if (live) {
    await pushCommand(id, cmd);
    return NextResponse.json({ ok: true, delivered: "runner" });
  }

  // No runner holds the job right now.
  const terminal = TERMINAL_STATUSES.includes(job.status);
  switch (cmd.type) {
    case "cancel":
      await redis().lrem(K.homeQueue, 0, id);
      await setStatus(id, "cancelled");
      await clearAllForJob(id);
      return NextResponse.json({ ok: true });
    case "resume":
    case "retry_agent":
      if (job.status === "cancelled") return NextResponse.json({ error: "Job was cancelled." }, { status: 409 });
      await clearAllForJob(id);
      await requeue(job, job.runOn);
      return NextResponse.json({ ok: true, delivered: "requeued" });
    case "raise_budget":
      await updateJob(id, { budgetUsd: cmd.budgetUsd });
      await clear(id, "over_budget");
      await clear(id, "budget_warning");
      if (job.status === "over_budget") await requeue(job, job.runOn);
      return NextResponse.json({ ok: true });
    default:
      if (terminal) return NextResponse.json({ error: `Job is ${job.status}; nothing is running.` }, { status: 409 });
      // A runner is starting: it reads commands from its saved cursor, so this is delivered on start.
      await pushCommand(id, cmd);
      return NextResponse.json({ ok: true, delivered: "queued" });
  }
}
