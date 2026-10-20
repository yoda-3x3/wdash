import { NextResponse } from "next/server";
import { NewJobInput } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { placeJob } from "@/lib/placement";
import { createJob, getProject } from "@/lib/relay";

export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = NewJobInput.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const project = await getProject(parsed.data.project);
  if (!project) return NextResponse.json({ error: "Unknown project. Is it in the PC's projects.json?" }, { status: 400 });
  const job = await createJob(parsed.data, project);
  await placeJob(job);
  return NextResponse.json({ id: job.id });
}
