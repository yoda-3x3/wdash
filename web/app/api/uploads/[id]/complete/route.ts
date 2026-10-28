import { NextResponse } from "next/server";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { completeUpload } from "@/lib/relay";

/** Finishes a chunked upload once every piece has arrived. Returns the file's metadata. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { id } = await params;
  try {
    return NextResponse.json(await completeUpload(id));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
