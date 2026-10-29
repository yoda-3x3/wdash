import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { K, kaggleAccelFor, type KaggleAccel, type KaggleControl, type KaggleSession } from "@wdash/shared";
import { DAEMON_ROOT } from "./config.js";
import type { Relay } from "./relay.js";

/**
 * Model servers on free Kaggle GPU notebooks (daemon/kaggle/server.py): Ollama behind a key-checking proxy and a
 * Cloudflare quick tunnel. Agents whose model is "kaggle" or "kaggle:<ollama model>" talk to one instead of Anthropic.
 * Each notebook announces its tunnel URL on a one-off ntfy.sh topic, since Kaggle can't be reached directly.
 *
 * Up to KAGGLE_MAX_SERVERS run at once, one per model when there's a free slot (so two models never swap on one GPU).
 * Slot n > 1 uses its own Kaggle account when ~/.kaggle/access_token_<n> and KAGGLE_USERNAME_<n> exist.
 */
export type KaggleServer = {
  slot: number;
  url: string;
  key: string;
  models: string[];
  /** When the notebook was pushed: Kaggle counts GPU time from boot. */
  startedAt: number;
  /** Kaggle account it runs on, for per-account GPU hours. */
  user?: string;
  /** Last time a health check got an answer; the session's end time once it's gone. */
  lastSeen?: number;
  accel?: KaggleAccel;
};

const API = "https://www.kaggle.com/api/v1";
const SLUG = "wdash-model-server";
const SERVERS_KEY = K.kaggleServers;
const SESSIONS_KEY = K.kaggleSessions;
const SESSION_KEEP_MS = 14 * 24 * 60 * 60_000;
const BOOT_TIMEOUT_MS = 25 * 60_000;

const cfg = () => ({
  // The first is the default and is loaded at boot. qwen3-coder writes tool calls as text under Claude Code's prompt.
  models: (process.env.KAGGLE_MODELS || "qwen3.8:27b").split(",").map((s) => s.trim()).filter(Boolean),
  maxServers: Math.max(1, Number(process.env.KAGGLE_MAX_SERVERS || 2)),
  idleMinutes: Number(process.env.KAGGLE_IDLE_MINUTES || 30),
  maxHours: Number(process.env.KAGGLE_MAX_HOURS || 8),
  contextLength: Number(process.env.KAGGLE_CONTEXT_LENGTH || 65536),
  machineShape: process.env.KAGGLE_MACHINE || "NvidiaTeslaT4",
});

export const defaultKaggleModel = () => cfg().models[0]!;

/**
 * Slot 1 is the main account; slot n uses its own token / KAGGLE_USERNAME_<n> if set, else the main account.
 * Tokens come from KAGGLE_API_TOKEN[_<n>] (cloud runs get them as secrets) or ~/.kaggle/access_token[_<n>].
 */
function account(slot: number): { auth: string; user: string } {
  const dir = join(homedir(), ".kaggle");
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim() : "");
  const own = slot > 1 ? (process.env[`KAGGLE_API_TOKEN_${slot}`] || read(`access_token_${slot}`)) : "";
  if (own) {
    const user = process.env[`KAGGLE_USERNAME_${slot}`];
    if (!user) throw new Error(`Set KAGGLE_USERNAME_${slot} in daemon/.env (the Kaggle username for access_token_${slot})`);
    return { auth: `Bearer ${own}`, user };
  }
  const json = join(dir, "kaggle.json");
  const legacy = existsSync(json) ? (JSON.parse(readFileSync(json, "utf8")) as { username: string; key: string }) : undefined;
  const tok = process.env.KAGGLE_API_TOKEN || read("access_token");
  const user = process.env.KAGGLE_USERNAME || legacy?.username;
  if (!user) throw new Error("Set KAGGLE_USERNAME in daemon/.env (your Kaggle username)");
  if (tok) return { auth: `Bearer ${tok}`, user };
  if (legacy) return { auth: `Basic ${Buffer.from(`${legacy.username}:${legacy.key}`).toString("base64")}`, user };
  throw new Error("No Kaggle token: put it in ~/.kaggle/access_token");
}

const slugFor = (slot: number) => (slot === 1 ? SLUG : `${SLUG}-${slot}`);

/** Kaggle settings and tokens for `wdash-daemon setup-cloud`, so cloud runs can start and use the servers too. */
export function kaggleCloudSecrets(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { KAGGLE_MODELS: process.env.KAGGLE_MODELS, KAGGLE_MAX_SERVERS: process.env.KAGGLE_MAX_SERVERS };
  for (let slot = 1; slot <= cfg().maxServers; slot++) {
    let a: { auth: string; user: string } | undefined;
    try {
      a = account(slot);
    } catch {
      continue;
    }
    if (!a.auth.startsWith("Bearer ")) continue;
    // Slot n without its own account uses slot 1's, which is already set.
    if (slot > 1 && a.user === account(1).user) continue;
    const sfx = slot === 1 ? "" : `_${slot}`;
    out[`KAGGLE_USERNAME${sfx}`] = a.user;
    out[`KAGGLE_API_TOKEN${sfx}`] = a.auth.slice("Bearer ".length);
  }
  return out;
}

async function api<T>(slot: number, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: account(slot).auth, "Content-Type": "application/json", ...init?.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kaggle ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function kernelStatus(slot = 1): Promise<{ status?: string; failureMessage?: string }> {
  return api(slot, `/kernels/status?userName=${encodeURIComponent(account(slot).user)}&kernelSlug=${slugFor(slot)}`);
}

/** Push (= start) a new version of a slot's server notebook. Returns the ntfy topic it will announce on. */
async function launch(slot: number, models: string[], accel: KaggleAccel): Promise<{ topic: string; key: string; since: number }> {
  const c = cfg();
  const key = randomBytes(24).toString("hex");
  const topic = `wdash-${randomBytes(16).toString("hex")}`;
  const config = JSON.stringify({ key, topic, models, accel, idleMinutes: c.idleMinutes, maxHours: c.maxHours, contextLength: c.contextLength });
  const text = readFileSync(join(DAEMON_ROOT, "kaggle", "server.py"), "utf8").replace("__WDASH_CONFIG__", config);
  const since = Math.floor(Date.now() / 1000);
  const out = await api<{ error?: string }>(slot, "/kernels/push", {
    method: "POST",
    body: JSON.stringify({
      slug: `${account(slot).user}/${slugFor(slot)}`,
      newTitle: slugFor(slot),
      text,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: accel === "gpu",
      enableTpu: accel === "tpu",
      enableInternet: true,
      ...(accel === "gpu" ? { machineShape: c.machineShape } : {}),
    }),
  });
  if (out.error) throw new Error(`Kaggle push: ${out.error}`);
  return { topic, key, since };
}

type Announcement = { state: string; url?: string; models?: string[]; model?: string; error?: string; reason?: string };

/** Poll the ntfy topic until the notebook says it's ready (or failed). */
async function waitReady(slot: number, topic: string, since: number, key: string, log: Log, timeoutMs = BOOT_TIMEOUT_MS): Promise<KaggleServer> {
  const deadline = Date.now() + timeoutMs;
  const name = `Kaggle server ${slot}`;
  let last = "";
  // A timestamp at first, then the id of the last message seen, so each poll only returns new ones.
  let cursor = String(since);
  while (Date.now() < deadline) {
    const res = await fetch(`https://ntfy.sh/${topic}/json?poll=1&since=${cursor}`).catch(() => undefined);
    const lines = res?.ok ? (await res.text()).split("\n").filter(Boolean) : [];
    for (const line of lines) {
      const m = JSON.parse(line) as { id: string; event: string; message?: string };
      if (m.event !== "message" || !m.message) continue;
      cursor = m.id;
      const a = JSON.parse(m.message) as Announcement;
      const label = a.state === "pulling" ? `pulling ${a.model}` : a.state;
      if (label !== last) await log(`${name}: ${(last = label)}`);
      if (a.state === "ready" && a.url) return { slot, url: a.url, key, models: a.models ?? [], startedAt: since * 1000, user: account(slot).user, lastSeen: Date.now() };
      if (a.state === "failed" || a.state === "stopped") throw new Error(`${name} ${a.state}: ${a.error ?? a.reason ?? ""}`);
    }
    const st = await kernelStatus(slot).catch(() => undefined);
    if (st?.status && /error|cancel/i.test(st.status)) throw new Error(`${name} notebook ${st.status}: ${st.failureMessage ?? ""}`);
    // Kaggle can hold a session in its queue for hours (no free GPUs); say so instead of looking stuck.
    if (st?.status && /queued/i.test(st.status) && last !== "queued") await log(`${name}: ${(last = "queued")} on Kaggle (waiting for a free GPU)`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error(`${name} didn't come up within ${Math.round(timeoutMs / 60_000)} minutes`);
}

export async function healthy(s: KaggleServer): Promise<boolean> {
  const res = await fetch(`${s.url}/wdash/health`, { headers: { Authorization: `Bearer ${s.key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  return !!res?.ok;
}

type Log = (s: string) => Promise<void> | void;

/** Servers that answer; dead ones are dropped from Redis. */
export async function liveKaggleServers(relay: Relay): Promise<KaggleServer[]> {
  // Before the pool, the one server lived at wd:kaggle:server.
  const old = await relay.r.get("wd:kaggle:server");
  if (old) {
    await relay.r.hset(SERVERS_KEY, "1", JSON.stringify({ ...JSON.parse(old), slot: 1 }));
    await relay.r.del("wd:kaggle:server");
  }
  const all = Object.values(await relay.r.hgetall(SERVERS_KEY)).map((v) => JSON.parse(v) as KaggleServer);
  const alive = await Promise.all(
    all.map(async (s) => {
      if (await healthy(s)) return { ...s, lastSeen: Date.now() } as KaggleServer;
      // Gone (idled off, time limit, or stopped on Kaggle): its GPU time ended around the last answer.
      await relay.r.hdel(SERVERS_KEY, String(s.slot));
      await recordSession(relay, s, s.lastSeen ?? s.startedAt);
      return undefined;
    }),
  );
  const live = alive.filter((s): s is KaggleServer => !!s).sort((a, b) => a.slot - b.slot);
  if (live.length) await relay.r.hset(SERVERS_KEY, Object.fromEntries(live.map((s) => [String(s.slot), JSON.stringify(s)])));
  return live;
}

const save = (relay: Relay, s: KaggleServer) => relay.r.hset(SERVERS_KEY, String(s.slot), JSON.stringify(s));

/** A finished server session, for GPU hours per account (the website's usage panel). Kept 14 days. */
async function recordSession(relay: Relay, s: KaggleServer, end: number): Promise<void> {
  const session: KaggleSession = { user: s.user ?? "?", slot: s.slot, start: s.startedAt, end: Math.max(end, s.startedAt), accel: s.accel ?? "gpu" };
  await relay.r.zadd(SESSIONS_KEY, session.end, JSON.stringify(session));
  await relay.r.zremrangebyscore(SESSIONS_KEY, 0, Date.now() - SESSION_KEEP_MS);
}

/** Model -> server, for kaggleAgent(). Filled by ensureKaggleFor(). */
const routes = new Map<string, KaggleServer>();
/** Launches in flight, by slot, so jobs asking at once share them. */
const launching = new Map<number, { models: string[]; p: Promise<KaggleServer> }>();

function boot(relay: Relay, slot: number, models: string[], log: Log): Promise<KaggleServer> {
  const accel = kaggleAccelFor(models[0]!);
  const p = (async () => {
    await log(`Starting Kaggle ${accel.toUpperCase()} server ${slot} for ${models.join(", ")} (first boot takes ~5-15 min${accel === "tpu" ? ", longer on TPU" : ""})...`);
    const { topic, key, since } = await launch(slot, models, accel);
    const s = { ...(await waitReady(slot, topic, since, key, log, accel === "tpu" ? 70 * 60_000 : BOOT_TIMEOUT_MS)), accel };
    await save(relay, s);
    return s;
  })().finally(() => launching.delete(slot));
  launching.set(slot, { models, p });
  return p;
}

/**
 * A server that serves `model`: one already running it, else a new server in a free slot, else the first running
 * server (which downloads the model and swaps it in when needed).
 */
export async function ensureKaggleFor(relay: Relay, model = defaultKaggleModel(), log: Log = () => undefined, bootModels = [model]): Promise<KaggleServer> {
  const live = await liveKaggleServers(relay);
  let s = live.find((x) => x.models.includes(model));
  if (!s) {
    const pending = [...launching.values()].find((l) => l.models.includes(model));
    if (pending) s = await pending.p;
  }
  if (!s) {
    const used = new Set([...live.map((x) => x.slot), ...launching.keys()]);
    const free = Array.from({ length: cfg().maxServers }, (_, i) => i + 1).find((n) => !used.has(n));
    if (free) s = await boot(relay, free, bootModels, log);
  }
  if (!s) {
    // No free slot: download the model onto a running Ollama (GPU) server. A TPU model needs its own server.
    const accel = kaggleAccelFor(model);
    const gpu = live.find((x) => (x.accel ?? "gpu") === "gpu");
    if (accel === "tpu" || !gpu) throw new Error(`Every Kaggle server slot is busy (${cfg().maxServers}); stop one to start a ${accel.toUpperCase()} server for ${model}.`);
    s = gpu;
    await ensureKaggleModel(s, model, log);
    s = { ...s, models: [...s.models, model] };
    await save(relay, s);
  }
  routes.set(model, s);
  return s;
}

/** Pull `model` onto a running server unless it's already there. Streamed: quick tunnels cut silent requests at 100 s. */
export async function ensureKaggleModel(s: KaggleServer, model: string, log: Log = () => undefined): Promise<void> {
  const h = { Authorization: `Bearer ${s.key}`, "Content-Type": "application/json" };
  const tags = (await (await fetch(`${s.url}/api/tags`, { headers: h })).json()) as { models?: Array<{ name: string }> };
  const have = (tags.models ?? []).map((m) => m.name);
  if (have.includes(model) || have.includes(`${model}:latest`)) return;
  await log(`Kaggle server ${s.slot}: downloading ${model} (first use, a few minutes)...`);
  const res = await fetch(`${s.url}/api/pull`, { method: "POST", headers: h, body: JSON.stringify({ model, stream: true }) });
  let last = "";
  for await (const chunk of res.body ?? []) last = Buffer.from(chunk).toString().trim().split("\n").pop() || last;
  const out = JSON.parse(last || "{}") as { status?: string; error?: string };
  if (!res.ok || out.error || out.status !== "success") throw new Error(`Couldn't download ${model} on Kaggle: ${out.error ?? res.status}`);
}

/** Stop every server (or one slot). Returns the slots that acknowledged. */
export async function stopKaggleServers(relay: Relay, slot?: number): Promise<number[]> {
  const all = Object.values(await relay.r.hgetall(SERVERS_KEY)).map((v) => JSON.parse(v) as KaggleServer);
  const stopped: number[] = [];
  for (const s of all.filter((x) => slot === undefined || x.slot === slot)) {
    await relay.r.hdel(SERVERS_KEY, String(s.slot));
    await recordSession(relay, s, Date.now());
    for (const [m, r] of routes) if (r.slot === s.slot) routes.delete(m);
    const res = await fetch(`${s.url}/wdash/stop`, { method: "POST", headers: { Authorization: `Bearer ${s.key}` } }).catch(() => undefined);
    if (res?.ok) stopped.push(s.slot);
  }
  return stopped;
}

/** Start/Stop buttons on the website. Progress goes to K.kaggleLog, which the usage panel shows. */
export async function handleKaggleControl(relay: Relay, ctl: KaggleControl): Promise<void> {
  const log = async (text: string) => {
    await relay.r.lpush(K.kaggleLog, JSON.stringify({ at: Date.now(), text }));
    await relay.r.ltrim(K.kaggleLog, 0, 29);
    await relay.r.expire(K.kaggleLog, 7 * 24 * 3600);
  };
  try {
    if (ctl.action === "stop") {
      const stopped = await stopKaggleServers(relay, ctl.slot);
      await log(stopped.length ? `Stopped Kaggle server ${ctl.slot}.` : `Kaggle server ${ctl.slot} wasn't running.`);
    } else {
      const s = await ensureKaggleFor(relay, ctl.model, log);
      await log(`Kaggle server ${s.slot} is ready with ${ctl.model}.`);
    }
  } catch (e) {
    await log(`Failed: ${(e as Error).message}`);
  }
}

export const isKaggleModel = (model: string) => model === "kaggle" || model.startsWith("kaggle:");

/** "kaggle" -> the default model; "kaggle:<name>" -> name. */
export const kaggleModelName = (model: string) => (model.startsWith("kaggle:") ? model.slice("kaggle:".length) : defaultKaggleModel());

/** Model name and env for an agent on a Kaggle server. Needs ensureKaggleFor() for that model to have run first. */
export function kaggleAgent(model: string): { model: string; env: Record<string, string | undefined> } {
  const name = kaggleModelName(model);
  const s = routes.get(name);
  if (!s) throw new Error(`No Kaggle server is serving ${name}`);
  return {
    model: name,
    env: {
      ANTHROPIC_BASE_URL: s.url,
      ANTHROPIC_AUTH_TOKEN: s.key,
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      ANTHROPIC_DEFAULT_OPUS_MODEL: name,
      ANTHROPIC_DEFAULT_SONNET_MODEL: name,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: name,
      CLAUDE_CODE_SUBAGENT_MODEL: name,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      API_TIMEOUT_MS: "900000",
    },
  };
}
