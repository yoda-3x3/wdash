import { execFileSync } from "node:child_process";

/**
 * FreeLLMAPI: the local router on this PC (http://127.0.0.1:31415) that speaks the Anthropic API and routes
 * to free models. Model ids look like "free:auto", "free:auto:fast" or "free:<FreeLLMAPI model id>".
 * PC only: cloud runs can't reach 127.0.0.1. The key is the FREELLMAPI_KEY user environment variable.
 */
export const FREE_URL = (process.env.FREELLMAPI_URL || "http://127.0.0.1:31415").replace(/\/+$/, "");

export const isFreeModel = (model: string) => model === "free" || model.startsWith("free:");

/** "free" -> "auto"; "free:<id>" -> id. */
export const freeModelName = (model: string) => (model.startsWith("free:") ? model.slice("free:".length) || "auto" : "auto");

function freeKey(): string | undefined {
  if (process.env.FREELLMAPI_KEY) return process.env.FREELLMAPI_KEY;
  // A daemon started before `setx FREELLMAPI_KEY` doesn't have it; read the saved user variable.
  if (process.platform !== "win32") return undefined;
  try {
    const out = execFileSync("reg.exe", ["query", "HKCU\\Environment", "/v", "FREELLMAPI_KEY"], { encoding: "utf8", windowsHide: true });
    const m = out.match(/FREELLMAPI_KEY\s+REG_\w+\s+(.+)/);
    return m?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Throws a readable error when the router is closed, the key is missing, or this is a cloud run. */
export async function ensureFree(): Promise<void> {
  if (process.env.GITHUB_ACTIONS) throw new Error("FreeLLMAPI models run on your PC only (the cloud can't reach it). Run this job on the PC.");
  const key = freeKey();
  if (!key) throw new Error("No FreeLLMAPI key on the PC. Run: setx FREELLMAPI_KEY \"your-key\", then restart the daemon.");
  let status = 0;
  try {
    const r = await fetch(`${FREE_URL}/v1/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000) });
    status = r.status;
  } catch {
    throw new Error(`FreeLLMAPI isn't running at ${FREE_URL}. Open the FreeLLMAPI app on the PC, then retry.`);
  }
  if (status === 401 || status === 403) throw new Error("FreeLLMAPI rejected the key in FREELLMAPI_KEY.");
  if (status >= 400) throw new Error(`FreeLLMAPI answered ${status}.`);
}

/** Model name and env for an agent on FreeLLMAPI. */
export function freeAgent(model: string): { model: string; env: Record<string, string | undefined> } {
  const name = freeModelName(model);
  const fast = name === "auto" ? "auto:fast" : name;
  return {
    model: name,
    env: {
      ANTHROPIC_BASE_URL: FREE_URL,
      ANTHROPIC_AUTH_TOKEN: freeKey(),
      ANTHROPIC_API_KEY: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: undefined,
      // A daemon started from inside a Claude Code session would pass its host-auth vars on, and FreeLLMAPI then answers 401.
      CLAUDECODE: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: undefined,
      CLAUDE_CODE_OAUTH_SCOPES: undefined,
      ANTHROPIC_MODEL: name,
      ANTHROPIC_DEFAULT_OPUS_MODEL: name,
      ANTHROPIC_DEFAULT_SONNET_MODEL: name,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: fast,
      CLAUDE_CODE_SUBAGENT_MODEL: name,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      API_TIMEOUT_MS: "600000",
    },
  };
}
