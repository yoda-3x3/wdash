import { NextResponse } from "next/server";
import { requireApiUser, sameOrigin } from "@/lib/auth";
import { stageUpload } from "@/lib/relay";
import { readUpload } from "@/lib/upload";

/** A file picked on the New job form, held until the job is created. */
export async function POST(req: Request) {
  const deny = await requireApiUser();
  if (deny) return deny;
  if (!sameOrigin(req)) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  const up = await readUpload(req);
  if (up instanceof NextResponse) return up;
  return NextResponse.json(await stageUpload(up.name, up.type, up.bytes));
}
