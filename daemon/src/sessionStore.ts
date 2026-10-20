import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { K, TTL_SECONDS } from "@wdash/shared";
import type { Relay } from "./relay.js";

/**
 * Mirrors Agent SDK transcripts into the relay so a job can resume on another machine
 * (home PC -> GitHub Actions runner) without copying ~/.claude files around. SPEC.md §10.
 *
 * The SDK derives SessionKey.projectKey from the cwd, which differs between machines, so each
 * agent gets its own store that pins every key to `fixedKey` (see sessionProjectKey()).
 */
export function redisSessionStore(relay: Relay, fixedKey: string): SessionStore {
  const r = relay.r;
  const listKey = (k: SessionKey) => K.sessions(fixedKey, k.sessionId, k.subpath);

  return {
    async append(key, entries) {
      if (!entries.length) return;
      const lk = listKey(key);
      // Dedupe by uuid (the SDK may retry a batch): SADD returns 1 only for entries not seen before.
      const marks = r.pipeline();
      for (const e of entries) if (e.uuid) marks.sadd(`${lk}:u`, e.uuid);
      const res = (await marks.exec()) ?? [];
      let i = 0;
      const fresh = entries.filter((e) => !e.uuid || res[i++]?.[1] === 1);
      const p = r.pipeline();
      if (fresh.length) p.rpush(lk, ...fresh.map((e) => JSON.stringify(e)));
      p.expire(lk, TTL_SECONDS);
      p.expire(`${lk}:u`, TTL_SECONDS);
      p.zadd(K.sessionIndex(fixedKey), Date.now(), key.sessionId);
      p.expire(K.sessionIndex(fixedKey), TTL_SECONDS);
      if (key.subpath) {
        p.sadd(K.sessionSubkeys(fixedKey, key.sessionId), key.subpath);
        p.expire(K.sessionSubkeys(fixedKey, key.sessionId), TTL_SECONDS);
      }
      await p.exec();
    },

    async load(key) {
      const items = await r.lrange(listKey(key), "0", "-1");
      if (!items.length) return null;
      return items.map((s) => JSON.parse(s) as SessionStoreEntry);
    },

    async listSessions() {
      const flat = await r.zrange(K.sessionIndex(fixedKey), "0", "-1", "WITHSCORES");
      const out: Array<{ sessionId: string; mtime: number }> = [];
      for (let i = 0; i < flat.length; i += 2) out.push({ sessionId: flat[i]!, mtime: Math.floor(Number(flat[i + 1])) });
      return out;
    },

    async delete(key) {
      const lk = listKey(key);
      await r.del(lk, `${lk}:u`);
      if (!key.subpath) await r.zrem(K.sessionIndex(fixedKey), key.sessionId);
    },

    async listSubkeys(key) {
      return r.smembers(K.sessionSubkeys(fixedKey, key.sessionId));
    },
  };
}
