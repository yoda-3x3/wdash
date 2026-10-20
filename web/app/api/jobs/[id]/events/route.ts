import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { getEvents } from "@/lib/relay";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id } = await params;
  const after = new URL(req.url).searchParams.get("after") ?? "-";
  if (after !== "-" && !/^\d+-\d+$/.test(after)) return NextResponse.json({ error: "bad cursor" }, { status: 400 });
  const events = await getEvents(id, after);
  return NextResponse.json({ events, cursor: events.at(-1)?.id ?? after });
}
