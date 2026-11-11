import { NextResponse } from "next/server";
import { K } from "@wdash/shared";
import { requireApiUser } from "@/lib/auth";
import { redis } from "@/lib/redis";

export const dynamic = "force-dynamic";

/** The skills every agent gets, as published by the PC daemon at start (daemon/src/skills.ts). */
export async function GET() {
  const deny = await requireApiUser();
  if (deny) return deny;
  const raw = await redis().get<string>(K.skills);
  let skills: Array<{ name: string; description: string }> = [];
  try {
    skills = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : [];
  } catch {
    skills = [];
  }
  return NextResponse.json({ skills }, { headers: { "cache-control": "no-store" } });
}
