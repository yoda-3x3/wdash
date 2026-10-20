import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { getProjects } from "@/lib/relay";

export const dynamic = "force-dynamic";

export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  return NextResponse.json({ projects: await getProjects() });
}
