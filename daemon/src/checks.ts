import { spawn } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "@wdash/shared";

// SPEC.md §6.4 — evidence required before the orchestrator may approve work.

export type CheckName = "build" | "test" | "screenshot";
export type CheckResult = { name: CheckName; ok: boolean; skipped?: boolean; output: string; durationMs: number; pngBase64?: string };

const TIMEOUT_MS = 20 * 60 * 1000;

function sh(command: string, cwd: string, extraEnv: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolveP) => {
    const child = spawn(command, { cwd, shell: true, env: { ...process.env, ...extraEnv, CI: "1" }, windowsHide: true });
    let out = "";
    const add = (b: Buffer) => {
      out += b.toString();
      if (out.length > 200_000) out = out.slice(-150_000);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code: code ?? 1, output: out });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ code: 1, output: `${out}\n${e.message}` });
    });
  });
}

export async function runChecks(project: ProjectConfig, cwd: string, stateDir: string, which: CheckName[] = ["build", "test", "screenshot"]): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const cmds = project.commands;
  if (cmds.install && !existsSync(join(cwd, "node_modules")) && existsSync(join(cwd, "package.json"))) {
    await sh(cmds.install, cwd);
  }
  for (const name of which) {
    const cmd = cmds[name];
    if (!cmd) {
      results.push({ name, ok: true, skipped: true, output: "not configured", durationMs: 0 });
      continue;
    }
    const t0 = Date.now();
    if (name === "screenshot") {
      mkdirSync(stateDir, { recursive: true });
      const png = join(stateDir, `shot-${Date.now()}.png`);
      const r = await sh(cmd, cwd, { WDASH_SCREENSHOT: png });
      const ok = r.code === 0 && existsSync(png);
      results.push({
        name,
        ok,
        output: tail(r.output),
        durationMs: Date.now() - t0,
        pngBase64: ok ? readFileSync(png).toString("base64") : undefined,
      });
    } else {
      const r = await sh(cmd, cwd);
      results.push({ name, ok: r.code === 0, output: tail(r.output), durationMs: Date.now() - t0 });
    }
  }
  return results;
}

function tail(s: string, n = 6000): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}
