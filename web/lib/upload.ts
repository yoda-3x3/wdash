import { NextResponse } from "next/server";
import { MAX_SHARE_BYTES } from "@wdash/shared";

/**
 * Reads a raw single-request upload (small files; big ones use the chunked /api/uploads/start flow): the body is the file's bytes, the name comes from the
 * x-file-name header (URI-encoded). Returns a 4xx response instead when it's unusable.
 */
export async function readUpload(req: Request): Promise<{ name: string; type: string; bytes: Uint8Array } | NextResponse> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_SHARE_BYTES) return tooBig();
  const name = decodeURIComponent(req.headers.get("x-file-name") ?? "");
  if (!name) return NextResponse.json({ error: "missing x-file-name" }, { status: 400 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_SHARE_BYTES) return tooBig();
  if (!bytes.byteLength) return NextResponse.json({ error: `${name} is empty.` }, { status: 400 });
  return { name, type: req.headers.get("content-type") ?? "application/octet-stream", bytes };
}

function tooBig(): NextResponse {
  return NextResponse.json({ error: `Files can be at most ${MAX_SHARE_BYTES / 1024 / 1024} MB.` }, { status: 413 });
}
