/** Upstash free plan. */
export const UPSTASH_REQUEST_LIMIT = 500_000;
export const UPSTASH_STORAGE_LIMIT = 256 * 1024 * 1024;

/**
 * Requests this month and storage for the database at `host`, from Upstash's management API
 * (an account email plus a management key from console.upstash.com/account/api).
 */
export async function upstashStats(email: string, apiKey: string, host: string): Promise<{ monthlyRequests?: number; storageBytes?: number }> {
  const auth = { Authorization: `Basic ${Buffer.from(`${email}:${apiKey}`).toString("base64")}` };
  const dbs = (await (await fetch("https://api.upstash.com/v2/redis/databases", { headers: auth })).json()) as Array<{ database_id: string; endpoint: string }>;
  const db = Array.isArray(dbs) ? dbs.find((d) => d.endpoint === host) : undefined;
  if (!db) throw new Error(`No database ${host} on that Upstash account`);
  const stats = (await (await fetch(`https://api.upstash.com/v2/redis/stats/${db.database_id}`, { headers: auth })).json()) as {
    total_monthly_requests?: number;
    current_storage?: number;
  };
  return { monthlyRequests: stats.total_monthly_requests, storageBytes: stats.current_storage };
}
