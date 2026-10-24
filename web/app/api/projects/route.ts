import { NextResponse } from "next/server";
import { K, NewProjectInput, ProjectConfig } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { createRepo } from "@/lib/github";
import { redis } from "@/lib/redis";
import { createProjectRequest, getProjects } from "@/lib/relay";

export const dynamic = "force-dynamic";

export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  return NextResponse.json({ projects: await getProjects() });
}

/**
 * New project. The website creates the GitHub repo itself when its token may (so it works with the PC off);
 * the project is usable right away in the cloud, and the PC clones it next time it's on. Otherwise the PC
 * creates the repo with its own gh login.
 */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = NewProjectInput.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  const input = parsed.data;
  const taken = (await getProjects()).some((p) => p.name.toLowerCase() === input.name.toLowerCase());
  if (taken) return NextResponse.json({ error: `A project named ${input.name} already exists.` }, { status: 409 });

  let created: Awaited<ReturnType<typeof createRepo>>;
  try {
    created = await createRepo(input.name, input.description);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
  if (!created) {
    // The token can't create repos: the PC does it with gh.
    return NextResponse.json({ ...(await createProjectRequest(input)), via: "pc" });
  }

  const commands: ProjectConfig["commands"] = {};
  if (input.testCommand?.trim()) commands.test = input.testCommand.trim();
  if (input.buildCommand?.trim()) commands.build = input.buildCommand.trim();
  const project = ProjectConfig.parse({ name: input.name, repo: created.repo, baseBranch: created.baseBranch, commands, defaultBudgetUsd: 2, cloud: true, autoDeploy: input.autoDeploy });
  await redis().hset(K.projects, { [project.name]: JSON.stringify(project) });
  // Ask the PC to clone it and add it to projects.json whenever it's next on.
  const adopt = await createProjectRequest(input, created.repo);
  return NextResponse.json({ ...adopt, status: "done", project: project.name, via: "web" });
}
