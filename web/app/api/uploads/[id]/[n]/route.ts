import { NextResponse } from "next/server";
import { UPLOAD_CHUNK_BYTES } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { putUploadChunk } from "@/lib/relay";

/** One piece of a chunked upload; the body is the piece's raw bytes. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string; n: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { id, n } = await params;
  if (Number(req.headers.get("content-length") ?? 0) > UPLOAD_CHUNK_BYTES) return NextResponse.json({ error: "piece too big" }, { status: 413 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  try {
    await putUploadChunk(id, Number(n), bytes);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
