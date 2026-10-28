import { NextResponse } from "next/server";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { addJobFile, addJobUpload, getJob, listFiles } from "@/lib/relay";
import { readUpload } from "@/lib/upload";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  const { id } = await params;
  return NextResponse.json({ files: await listFiles(id) });
}

/** Adds a file to a running job; the chat message that references it delivers it to the agents. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const { id } = await params;
  if (!(await getJob(id))) return NextResponse.json({ error: "not found" }, { status: 404 });
  // A file already sent in pieces (/api/uploads/start ...): just attach it.
  const uploadId = req.headers.get("x-upload-id");
  if (uploadId) {
    try {
      return NextResponse.json(await addJobUpload(id, uploadId));
    } catch (e) {
      return NextResponse.json({ error: (e as Error).message }, { status: 400 });
    }
  }
  const up = await readUpload(req);
  if (up instanceof NextResponse) return up;
  try {
    return NextResponse.json(await addJobFile(id, up.name, up.type, up.bytes));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
