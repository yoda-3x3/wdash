import { Redis } from "@upstash/redis";

let client: Redis | undefined;

/** Upstash REST client. Values come back as raw strings; parse with the shared zod schemas. */
export function redis(): Redis {
  if (!client) {
    client = new Redis({
      // KV_* names are what Vercel's Upstash integration sets.
      url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "",
      automaticDeserialization: false,
    });
  }
  return client;
}

/** HGETALL as a field -> value map. With automaticDeserialization off, Upstash returns the raw flat array. */
export async function hgetall(key: string): Promise<Record<string, string>> {
  const raw = (await redis().hgetall(key)) as unknown;
  if (!raw) return {};
  if (!Array.isArray(raw)) return raw as Record<string, string>;
  const out: Record<string, string> = {};
  for (let i = 0; i < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1]);
  return out;
}

/** XRANGE as [id, fields] pairs, oldest first. */
export async function xrange(key: string, start: string, end: string, count?: number): Promise<Array<[string, Record<string, string>]>> {
  const raw = (await redis().xrange(key, start, end, count)) as unknown;
  if (!raw) return [];
  if (!Array.isArray(raw)) return Object.entries(raw as Record<string, Record<string, string>>);
  return (raw as Array<[string, string[]]>).map(([id, flat]) => {
    const f: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) f[flat[i]!] = flat[i + 1]!;
    return [id, f];
  });
}

/** XREVRANGE as [id, fields] pairs, newest first. */
export async function xrevrange(key: string, end: string, start: string, count?: number): Promise<Array<[string, Record<string, string>]>> {
  const raw = (await redis().xrevrange(key, end, start, count)) as unknown;
  if (!raw) return [];
  if (!Array.isArray(raw)) return Object.entries(raw as Record<string, Record<string, string>>);
  return (raw as Array<[string, string[]]>).map(([id, flat]) => {
    const f: Record<string, string> = {};
    for (let i = 0; i < flat.length; i += 2) f[flat[i]!] = flat[i + 1]!;
    return [id, f];
  });
}
