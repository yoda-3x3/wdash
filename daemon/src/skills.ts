import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/**
 * Every skill the user has in Claude Code, for wdash agents.
 *
 * Agents run with settingSources: [] (user allow-rules would bypass the wdash policy), so they don't see
 * ~/.claude/skills or installed plugins on their own. This builds one local plugin, "skills", whose skills/
 * folder holds a junction to each skill found in:
 *   - ~/.claude/skills/<name>                 (the user's own)
 *   - ~/.claude/skills/synced/<id>/<name>     (skills synced from claude.ai)
 *   - <installed plugin>/skills/<name>        (plugins from ~/.claude/plugins/installed_plugins.json)
 * Only the skills are taken: the plugins' hooks and MCP servers stay out of wdash agents.
 * The first skill with a given name wins. Rebuilt once per daemon start.
 */
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

let built: { dir: string; names: string[]; roots: string[] } | undefined;

export function skillsPlugin(stateDir: string): { dir: string; names: string[]; roots: string[] } {
  if (built) return built;
  const dir = resolve(stateDir, "skills-plugin");
  const skillsDir = join(dir, "skills");
  // rmSync on a junction removes the link, not the target.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(
    join(dir, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "skills", version: "1.0.0", description: "The user's Claude Code skills, for wdash agents" }, null, 2),
  );

  const names: string[] = [];
  const roots = new Set<string>([dir]);
  for (const { root, path, name } of findSkills()) {
    if (names.includes(name)) continue;
    try {
      symlinkSync(path, join(skillsDir, name), "junction");
      names.push(name);
      roots.add(root);
    } catch {
      /* unreadable or odd name: skip */
    }
  }
  built = { dir, names: names.sort(), roots: [...roots] };
  return built;
}

export type SkillInfo = { name: string; description: string };

/** Name and description of every skill agents get (from SKILL.md frontmatter), for the website's /skills page. */
export function skillsList(stateDir: string): SkillInfo[] {
  const { dir, names } = skillsPlugin(stateDir);
  return names.map((name) => {
    let description = "";
    try {
      const md = readFileSync(join(dir, "skills", name, "SKILL.md"), "utf8");
      const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const m = fm.match(/^description:\s*(?:>-?|\|-?)?\s*\r?\n?([\s\S]*?)(?=\r?\n[\w-]+:|$)/m);
      description = (m?.[1] ?? "").replace(/\s+/g, " ").replace(/^["']|["']$/g, "").trim();
    } catch {
      /* no description */
    }
    return { name, description: description.slice(0, 400) };
  });
}

function findSkills(): Array<{ root: string; path: string; name: string }> {
  const out: Array<{ root: string; path: string; name: string }> = [];
  const userSkills = join(CLAUDE_DIR, "skills");
  out.push(...skillDirs(userSkills, userSkills));
  const synced = join(userSkills, "synced");
  for (const id of subdirs(synced)) out.push(...skillDirs(join(synced, id), userSkills));
  // Plugins synced from claude.ai (e.g. Desktop Commander): ~/.claude/plugins/synced/<org>/<plugin>/.
  const syncedPlugins = join(CLAUDE_DIR, "plugins", "synced");
  const synced2 = subdirs(syncedPlugins).flatMap((a) => subdirs(join(syncedPlugins, a)).map((b) => join(syncedPlugins, a, b)));
  for (const p of [...installedPlugins(), ...synced2]) {
    // Read access covers just this plugin's install folder (it may live outside ~/.claude/plugins).
    const root = p;
    out.push(...skillDirs(join(p, "skills"), root));
    // plugin.json "skills" may list extra skill folders (or folders of skills), e.g. skills/engineering/tdd.
    for (const rel of manifestSkillPaths(p)) {
      const dir = resolve(p, rel);
      const name = basename(dir);
      if (existsSync(join(dir, "SKILL.md"))) {
        if (/^[\w.-]+$/.test(name)) out.push({ root, path: dir, name });
      } else out.push(...skillDirs(dir, root));
    }
  }
  return out;
}

function manifestSkillPaths(pluginDir: string): string[] {
  try {
    const j = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")) as { skills?: unknown };
    const s = typeof j.skills === "string" ? [j.skills] : Array.isArray(j.skills) ? j.skills : [];
    return s.filter((x): x is string => typeof x === "string");
  } catch {
    return [];
  }
}

/** Folders under `dir` that contain a SKILL.md. */
function skillDirs(dir: string, root: string) {
  return subdirs(dir)
    .filter((n) => /^[\w.-]+$/.test(n) && existsSync(join(dir, n, "SKILL.md")))
    .map((name) => ({ root, path: join(dir, name), name }));
}

function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() || d.isSymbolicLink())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

function installedPlugins(): string[] {
  try {
    const j = JSON.parse(readFileSync(join(CLAUDE_DIR, "plugins", "installed_plugins.json"), "utf8")) as {
      plugins?: Record<string, Array<{ installPath?: string }>>;
    };
    return Object.values(j.plugins ?? {})
      .map((v) => v[0]?.installPath)
      .filter((p): p is string => !!p && existsSync(p));
  } catch {
    return [];
  }
}
