import { NextResponse } from "next/server";
import { K } from "@wdash/shared";
import { requireApiUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id } = await params;
  const v = await redis().get<string>(K.pong(id));
  return NextResponse.json(v ? { pong: JSON.parse(v) } : { pong: null });
}
