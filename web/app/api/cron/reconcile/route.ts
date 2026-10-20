import { NextResponse } from "next/server";
import { reconcile } from "@/lib/placement";

export const dynamic = "force-dynamic";

/** Hit every 1-2 min by an external scheduler (QStash / cron-job.org) with `Authorization: Bearer $CRON_SECRET`. */
async function handle(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  await reconcile(true);
  return NextResponse.json({ ok: true });
}

export { handle as GET, handle as POST };
