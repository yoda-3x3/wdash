import { NextResponse } from "next/server";
import { K, NO_PROJECT, NewJobInput } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { placeJob } from "@/lib/placement";
import { redis } from "@/lib/redis";
import { attachUploads, createJob, emit, getProject } from "@/lib/relay";

export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = NewJobInput.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  if (parsed.data.project === NO_PROJECT && parsed.data.kind !== "chat") {
    return NextResponse.json({ error: "Team jobs need a project. Pick one, or start a chat instead." }, { status: 400 });
  }
  const project = await getProject(parsed.data.project);
  if (!project) return NextResponse.json({ error: "Unknown project. Is it in the PC's projects.json?" }, { status: 400 });
  const uploads = parsed.data.attachments;
  // Check before creating the job, so a stale upload doesn't leave a half-made job behind.
  for (const u of uploads) {
    if (!(await redis().exists(K.upload(u)))) {
      return NextResponse.json({ error: "An attached file expired or failed to upload. Remove it and attach it again." }, { status: 400 });
    }
  }
  const job = await createJob(parsed.data, project);
  // Attach before placing the job, so the runner sees the files when it starts.
  if (uploads.length) {
    const files = await attachUploads(job.id, uploads);
    await emit(job.id, "info", { text: `Attached ${files.map((f) => f.name).join(", ")}` });
  }
  await placeJob(job);
  return NextResponse.json({ id: job.id });
}
