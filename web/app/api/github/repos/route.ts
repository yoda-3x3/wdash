import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { listMyRepos } from "@/lib/github";

export const dynamic = "force-dynamic";

/** Your GitHub repos, so any of them can be picked as a project on the New job form. */
export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  try {
    return NextResponse.json({ repos: await listMyRepos() });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message, repos: [] }, { status: 502 });
  }
}
