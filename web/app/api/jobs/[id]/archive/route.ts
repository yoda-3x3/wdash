import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { readArchive } from "@/lib/github";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id } = await params;
  const data = await readArchive(id);
  if (!data) return NextResponse.json({ error: "not archived" }, { status: 404 });
  return NextResponse.json(data);
}
