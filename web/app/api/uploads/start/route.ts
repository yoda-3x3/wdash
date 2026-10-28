import { NextResponse } from "next/server";
import { UPLOAD_CHUNK_BYTES } from "@wdash/shared";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { startUpload } from "@/lib/relay";

/**
 * Starts a chunked upload (files up to MAX_ATTACHMENT_BYTES). The browser then PUTs each piece to
 * /api/uploads/:id/:n and finishes with POST /api/uploads/:id/complete.
 */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { name?: unknown; size?: unknown; type?: unknown } | null;
  if (typeof body?.name !== "string" || !body.name || typeof body.size !== "number") {
    return NextResponse.json({ error: "send { name, size, type }" }, { status: 400 });
  }
  try {
    const meta = await startUpload(body.name, typeof body.type === "string" ? body.type : "", body.size);
    return NextResponse.json({ meta, chunkBytes: UPLOAD_CHUNK_BYTES });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 413 });
  }
}
