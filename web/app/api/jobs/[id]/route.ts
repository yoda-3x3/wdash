import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { listAttention } from "@/lib/attention";
import { getJobDetail } from "@/lib/relay";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id } = await params;
  const detail = await getJobDetail(id);
  if (!detail.job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const attention = (await listAttention()).filter((a) => a.jobId === id);
  return NextResponse.json({ ...detail, attention });
}
