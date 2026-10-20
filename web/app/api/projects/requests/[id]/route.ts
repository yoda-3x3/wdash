import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { getProjectRequest } from "@/lib/relay";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id } = await params;
  const r = await getProjectRequest(id);
  if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(r);
}
