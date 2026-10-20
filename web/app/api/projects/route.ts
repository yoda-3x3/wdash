import { NextResponse } from "next/server";
import { NewProjectInput } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { createProjectRequest, getProjects } from "@/lib/relay";

export const dynamic = "force-dynamic";

export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  return NextResponse.json({ projects: await getProjects() });
}

/** New project: the home daemon creates the GitHub repo, clones it, and registers it. */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = NewProjectInput.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const taken = (await getProjects()).some((p) => p.name.toLowerCase() === parsed.data.name.toLowerCase());
  if (taken) return NextResponse.json({ error: `A project named ${parsed.data.name} already exists.` }, { status: 409 });
  return NextResponse.json(await createProjectRequest(parsed.data));
}
