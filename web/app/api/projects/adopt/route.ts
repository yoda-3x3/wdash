import { NextResponse } from "next/server";
import { AdoptRepoInput, K, NewProjectInput, ProjectConfig } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { getRepo } from "@/lib/github";
import { redis } from "@/lib/redis";
import { createProjectRequest, getProjects } from "@/lib/relay";

export const dynamic = "force-dynamic";

/**
 * Use an existing GitHub repo as a project (picked from "Your GitHub repos" on the New job form).
 * It's usable in the cloud right away; the PC clones it next time it's on, or right before it runs a job for it.
 */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const parsed = AdoptRepoInput.safeParse(await req.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, { status: 400 });

  const projects = await getProjects();
  const wanted = parsed.data.repo.toLowerCase();
  const existing = projects.find((p) => p.repo.toLowerCase() === wanted);
  if (existing) return NextResponse.json({ project: existing.name, existing: true });

  const found = await getRepo(parsed.data.repo).catch(() => undefined);
  if (!found) return NextResponse.json({ error: `GitHub token can't see ${parsed.data.repo}.` }, { status: 404 });

  // The project is named after the repo; owner-repo if another project already has that name.
  const [owner, repoName] = found.repo.split("/") as [string, string];
  const taken = (n: string) => projects.some((p) => p.name.toLowerCase() === n.toLowerCase());
  const name = taken(repoName) ? `${owner}-${repoName}` : repoName;
  const input = NewProjectInput.safeParse({ name, autoDeploy: false });
  if (!input.success || taken(name)) return NextResponse.json({ error: `Can't use ${found.repo} as a project name (${name}).` }, { status: 409 });

  const project = ProjectConfig.parse({ name, repo: found.repo, baseBranch: found.baseBranch, commands: {}, defaultBudgetUsd: 2, cloud: true, autoDeploy: false });
  await redis().hset(K.projects, { [project.name]: JSON.stringify(project) });
  // The PC clones it and adds it to projects.json.
  await createProjectRequest(input.data, found.repo);
  return NextResponse.json({ project: project.name, existing: false });
}
