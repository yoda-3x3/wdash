import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** The commit this deployment was built from; pages compare it with the one they were built with. */
export function GET() {
  return NextResponse.json({ version: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }, { headers: { "cache-control": "no-store" } });
}
