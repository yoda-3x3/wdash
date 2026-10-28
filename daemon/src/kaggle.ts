import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DAEMON_ROOT } from "./config.js";
import type { Relay } from "./relay.js";

/**
 * A model server on a free Kaggle GPU notebook (daemon/kaggle/server.py): Ollama behind a key-checking proxy and a
 * Cloudflare quick tunnel. Agents whose model is "kaggle" or "kaggle:<ollama model>" talk to it instead of Anthropic.
 * The notebook announces its tunnel URL on a one-off ntfy.sh topic, since Kaggle can't be reached directly.
 */
export type KaggleServer = { url: string; key: string; models: string[]; startedAt: number };

const API = "https://www.kaggle.com/api/v1";
const SLUG = "wdash-model-server";
const SERVER_KEY = "wd:kaggle:server";
const BOOT_TIMEOUT_MS = 25 * 60_000;

const cfg = () => ({
  // The first is the default and is loaded at boot. qwen3-coder writes tool calls as text under Claude Code's prompt.
  models: (process.env.KAGGLE_MODELS ?? "qwen3.8:27b").split(",").map((s) => s.trim()).filter(Boolean),
  idleMinutes: Number(process.env.KAGGLE_IDLE_MINUTES ?? 30),
  maxHours: Number(process.env.KAGGLE_MAX_HOURS ?? 8),
  contextLength: Number(process.env.KAGGLE_CONTEXT_LENGTH ?? 65536),
  machineShape: process.env.KAGGLE_MACHINE ?? "NvidiaTeslaT4",
});

/** ~/.kaggle/access_token (new KGAT_ tokens) or KAGGLE_API_TOKEN; legacy kaggle.json uses basic auth. */
function auth(): string {
  const dir = join(homedir(), ".kaggle");
  const tok = process.env.KAGGLE_API_TOKEN ?? (existsSync(join(dir, "access_token")) ? readFileSync(join(dir, "access_token"), "utf8").trim() : "");
  if (tok) return `Bearer ${tok}`;
  const json = join(dir, "kaggle.json");
  if (existsSync(json)) {
    const { username, key } = JSON.parse(readFileSync(json, "utf8"));
    return `Basic ${Buffer.from(`${username}:${key}`).toString("base64")}`;
  }
  throw new Error("No Kaggle token: put it in ~/.kaggle/access_token");
}

function username(): string {
  const json = join(homedir(), ".kaggle", "kaggle.json");
  const u = process.env.KAGGLE_USERNAME ?? (existsSync(json) ? JSON.parse(readFileSync(json, "utf8")).username : undefined);
  if (!u) throw new Error("Set KAGGLE_USERNAME in daemon/.env (your Kaggle username)");
  return u;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: auth(), "Content-Type": "application/json", ...init?.headers } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kaggle ${path.split("?")[0]}: ${res.status} ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function kernelStatus(): Promise<{ status?: string; failureMessage?: string }> {
  return api(`/kernels/status?userName=${encodeURIComponent(username())}&kernelSlug=${SLUG}`);
}

/** Push (= start) a new version of the server notebook. Returns the ntfy topic it will announce on. */
async function launch(): Promise<{ topic: string; key: string; since: number }> {
  const c = cfg();
  const key = randomBytes(24).toString("hex");
  const topic = `wdash-${randomBytes(16).toString("hex")}`;
  const config = JSON.stringify({ key, topic, models: c.models, idleMinutes: c.idleMinutes, maxHours: c.maxHours, contextLength: c.contextLength });
  const text = readFileSync(join(DAEMON_ROOT, "kaggle", "server.py"), "utf8").replace("__WDASH_CONFIG__", config);
  const since = Math.floor(Date.now() / 1000);
  const out = await api<{ error?: string; url?: string }>("/kernels/push", {
    method: "POST",
    body: JSON.stringify({
      slug: `${username()}/${SLUG}`,
      newTitle: SLUG,
      text,
      language: "python",
      kernelType: "script",
      isPrivate: true,
      enableGpu: true,
      enableTpu: false,
      enableInternet: true,
      machineShape: c.machineShape,
    }),
  });
  if (out.error) throw new Error(`Kaggle push: ${out.error}`);
  return { topic, key, since };
}

type Announcement = { state: string; url?: string; models?: string[]; model?: string; error?: string; reason?: string };

/** Poll the ntfy topic until the notebook says it's ready (or failed). */
async function waitReady(topic: string, since: number, key: string, log: (s: string) => Promise<void> | void): Promise<KaggleServer> {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
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
      if (label !== last) await log(`Kaggle server: ${(last = label)}`);
      if (a.state === "ready" && a.url) return { url: a.url, key, models: a.models ?? [], startedAt: Date.now() };
      if (a.state === "failed" || a.state === "stopped") throw new Error(`Kaggle server ${a.state}: ${a.error ?? a.reason ?? ""}`);
    }
    const st = await kernelStatus().catch(() => undefined);
    if (st?.status && /error|cancel/i.test(st.status)) throw new Error(`Kaggle notebook ${st.status}: ${st.failureMessage ?? ""}`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error("Kaggle server didn't come up within 25 minutes");
}

export async function healthy(s: KaggleServer): Promise<boolean> {
  const res = await fetch(`${s.url}/wdash/health`, { headers: { Authorization: `Bearer ${s.key}` }, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
  return !!res?.ok;
}

let current: KaggleServer | undefined;
let starting: Promise<KaggleServer> | undefined;

/** The running server, starting one on Kaggle if needed (several jobs asking at once share one launch). */
export async function ensureKaggleServer(relay: Relay, log: (s: string) => Promise<void> | void = () => undefined): Promise<KaggleServer> {
  if (current && (await healthy(current))) return current;
  const saved = await relay.r.get(SERVER_KEY);
  if (saved) {
    const s = JSON.parse(saved) as KaggleServer;
    if (await healthy(s)) return (current = s);
  }
  starting ??= (async () => {
    await log("Starting the Kaggle model server (first boot takes ~5-15 min)...");
    const { topic, key, since } = await launch();
    const s = await waitReady(topic, since, key, log);
    await relay.r.set(SERVER_KEY, JSON.stringify(s));
    return (current = s);
  })().finally(() => (starting = undefined));
  return starting;
}

export async function stopKaggleServer(relay: Relay): Promise<boolean> {
  const saved = await relay.r.get(SERVER_KEY);
  await relay.r.del(SERVER_KEY);
  current = undefined;
  if (!saved) return false;
  const s = JSON.parse(saved) as KaggleServer;
  const res = await fetch(`${s.url}/wdash/stop`, { method: "POST", headers: { Authorization: `Bearer ${s.key}` } }).catch(() => undefined);
  return !!res?.ok;
}

export const isKaggleModel = (model: string) => model === "kaggle" || model.startsWith("kaggle:");

/** Model name and env for an agent on the Kaggle server. Needs ensureKaggleServer() to have run first. */
export function kaggleAgent(model: string): { model: string; env: Record<string, string | undefined> } {
  if (!current) throw new Error("Kaggle server isn't running");
  const name = model.startsWith("kaggle:") ? model.slice("kaggle:".length) : current.models[0] ?? cfg().models[0];
  return {
    model: name,
    env: {
      ANTHROPIC_BASE_URL: current.url,
      ANTHROPIC_AUTH_TOKEN: current.key,
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
