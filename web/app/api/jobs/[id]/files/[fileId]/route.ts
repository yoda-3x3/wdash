import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth";
import { getFileData, listFiles } from "@/lib/relay";

/** Download an attachment. Always as a download, never rendered inline on this origin. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; fileId: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id, fileId } = await params;
  const meta = (await listFiles(id)).find((f) => f.id === fileId);
  const data = meta && (await getFileData(id, fileId));
  if (!meta || !data) return NextResponse.json({ error: "not found" }, { status: 404 });
  return new NextResponse(new Uint8Array(data), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}
