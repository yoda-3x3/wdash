import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ProjectConfig } from "@wdash/shared";

const here = dirname(fileURLToPath(import.meta.url));
export const DAEMON_ROOT = resolve(here, "..");

const envFile = join(DAEMON_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const Env = z.object({
  WDASH_REDIS_URL: z.string().min(1, "WDASH_REDIS_URL is required (rediss://default:<token>@<host>:6379)"),
  WDASH_STATE_DIR: z.string().default(join(DAEMON_ROOT, ".state")),
  WDASH_PROJECTS_FILE: z.string().default(join(DAEMON_ROOT, "config", "projects.json")),
  WDASH_WEB_URL: z.string().default("http://localhost:3000"),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:wdash@example.com"),
  /** Minutes without events before a running agent counts as stalled. */
  WDASH_STALL_MINUTES: z.coerce.number().default(10),
  /** Minutes a worker may run before the orchestrator is asked to split its work across helpers. */
  WDASH_HELP_MINUTES: z.coerce.number().default(10),
});

export type Env = z.infer<typeof Env>;

let cached: Env | undefined;
export function env(): Env {
  if (!cached) {
    const parsed = Env.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(`wdash daemon config error:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
    }
    cached = parsed.data;
    mkdirSync(cached.WDASH_STATE_DIR, { recursive: true });
  }
  return cached;
}

/** Allowlisted projects from daemon/config/projects.json (home PC only). */
export function loadLocalProjects(): ProjectConfig[] {
  const file = env().WDASH_PROJECTS_FILE;
  if (!existsSync(file)) return [];
  const raw = JSON.parse(readFileSync(file, "utf8"));
  return z.array(ProjectConfig).parse(raw);
}
