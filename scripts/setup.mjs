#!/usr/bin/env node
// wdash one-time setup. Run in your own terminal from the wdash folder:
//   node scripts/setup.mjs            collect keys, write env files, set GitHub secrets
//   node scripts/setup.mjs --vercel   also push the web env vars to your linked Vercel project
//
// Secrets are typed here (hidden) and only written to gitignored files, GitHub Actions secrets,
// and Vercel env vars. Generated values (VAPID keys etc.) are kept in .wdash-setup.json so
// re-running doesn't rotate them; rotating VAPID keys would break existing push subscriptions.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { stdin, stdout } from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stateFile = join(root, ".wdash-setup.json");
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const wantVercel = process.argv.includes("--vercel");
const win = process.platform === "win32";

// ---------------------------------------------------------------- prompts

const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
let muted = false;
rl._writeToOutput = (s) => {
  if (!muted || s.includes("\n") || s.includes("\r")) stdout.write(muted ? "\n" : s);
};

function ask(q, { def, secret = false } = {}) {
  return new Promise((resolve) => {
    const shown = def ? (secret ? " [keep current]" : ` [${def}]`) : "";
    stdout.write(`${q}${shown}: `);
    muted = secret;
    rl.question("", (a) => {
      muted = false;
      resolve(a.trim() || def || "");
    });
  });
}

async function need(key, q, opts = {}) {
  let v = "";
  while (!v) {
    v = await ask(q, { ...opts, def: state[key] ?? opts.def });
    if (opts.check && v && !opts.check(v)) {
      console.log(`  ✗ ${opts.hint ?? "doesn't look right"}`);
      v = "";
    }
  }
  state[key] = v;
  save();
  return v;
}

function sh(cmd, args, input) {
  const r = spawnSync(cmd, args, { input, encoding: "utf8", shell: win, stdio: input === undefined ? ["inherit", "pipe", "pipe"] : ["pipe", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

// ---------------------------------------------------------------- generated values

const require = createRequire(join(root, "web", "package.json"));
if (!state.VAPID_PUBLIC_KEY) {
  const keys = require("web-push").generateVAPIDKeys();
  state.VAPID_PUBLIC_KEY = keys.publicKey;
  state.VAPID_PRIVATE_KEY = keys.privateKey;
}
state.NEXTAUTH_SECRET ??= randomBytes(32).toString("base64");
state.CRON_SECRET ??= randomBytes(24).toString("hex");
save();

// ---------------------------------------------------------------- collect

console.log("\nwdash setup — README.md 'Setup' explains where each value comes from.\n");

const ghLogin = sh("gh", ["api", "user", "-q", ".login"]);
const login = await need("ALLOWED_GITHUB_LOGIN", "GitHub login allowed to sign in", { def: ghLogin.ok ? ghLogin.out : undefined });
const webUrl = (
  await need("WEB_URL", "Vercel URL of the dashboard (e.g. https://wdash-you.vercel.app)", { check: (v) => /^https:\/\/[^/]+$/.test(v.replace(/\/$/, "")), hint: "use the https:// origin, no path" })
).replace(/\/$/, "");
state.WEB_URL = webUrl;
console.log(`\nGitHub OAuth app callback URL must be: ${webUrl}/api/auth/callback/github`);
await need("GITHUB_ID", "GitHub OAuth app Client ID");
await need("GITHUB_SECRET", "GitHub OAuth app Client secret", { secret: true });
const viaVercel = /^y/i.test(await ask("Did you create Redis through Vercel's Upstash integration? (y/n)", { def: state.REDIS_VIA_VERCEL ?? "y" }));
state.REDIS_VIA_VERCEL = viaVercel ? "y" : "n";
if (viaVercel) {
  // Vercel already injects KV_REST_API_URL / KV_REST_API_TOKEN into the site.
  delete state.UPSTASH_REDIS_REST_URL;
  delete state.UPSTASH_REDIS_REST_TOKEN;
  console.log("  The daemon still needs the TCP URL: Vercel → Storage → your database → .env.local tab → REDIS_URL (or KV_URL).");
} else {
  await need("UPSTASH_REDIS_REST_URL", "Upstash REST URL", { check: (v) => v.startsWith("https://"), hint: "starts with https://" });
  await need("UPSTASH_REDIS_REST_TOKEN", "Upstash REST token", { secret: true });
}
await need("WDASH_REDIS_URL", "Redis TCP URL (rediss://default:...@...:6379)", { secret: true, check: (v) => /^rediss?:\/\//.test(v), hint: "starts with rediss://" });
await need("GITHUB_DISPATCH_TOKEN", "Fine-grained GitHub token (Actions + Contents read/write on wdash and project repos)", { secret: true });
await need("CLAUDE_CODE_OAUTH_TOKEN", "Claude token from `claude setup-token`", { secret: true });

const owner = login;
const wdashRepo = await need("WDASH_REPO", "wdash repo (owner/name)", { def: `${owner}/wdash` });

let projects = [];
const projFile = join(root, "daemon", "config", "projects.json");
if (existsSync(projFile)) projects = JSON.parse(readFileSync(projFile, "utf8"));
const cloudRepos = projects.filter((p) => p.cloud !== false).map((p) => p.repo);
const reposIn = await ask("Project repos that run in the cloud (comma separated)", { def: cloudRepos.join(",") || state.PROJECT_REPOS });
state.PROJECT_REPOS = reposIn;
save();
rl.close();

// ---------------------------------------------------------------- write local env files

writeFileSync(
  join(root, "daemon", ".env"),
  [
    `WDASH_REDIS_URL=${state.WDASH_REDIS_URL}`,
    // Lets the home daemon's agents run on your subscription without a separate `claude /login`.
    `CLAUDE_CODE_OAUTH_TOKEN=${state.CLAUDE_CODE_OAUTH_TOKEN}`,
    `WDASH_WEB_URL=${webUrl}`,
    `VAPID_PUBLIC_KEY=${state.VAPID_PUBLIC_KEY}`,
    `VAPID_PRIVATE_KEY=${state.VAPID_PRIVATE_KEY}`,
    `VAPID_SUBJECT=mailto:${login}@users.noreply.github.com`,
    "",
  ].join("\n"),
);
console.log("\n✓ wrote daemon/.env");

const webEnv = {
  GITHUB_ID: state.GITHUB_ID,
  GITHUB_SECRET: state.GITHUB_SECRET,
  ALLOWED_GITHUB_LOGIN: login,
  NEXTAUTH_SECRET: state.NEXTAUTH_SECRET,
  NEXTAUTH_URL: webUrl,
  ...(state.UPSTASH_REDIS_REST_URL ? { UPSTASH_REDIS_REST_URL: state.UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN: state.UPSTASH_REDIS_REST_TOKEN } : {}),
  GITHUB_DISPATCH_TOKEN: state.GITHUB_DISPATCH_TOKEN,
  WDASH_ARCHIVE_REPO: wdashRepo,
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: state.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: state.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: `mailto:${login}@users.noreply.github.com`,
  CRON_SECRET: state.CRON_SECRET,
};
writeFileSync(
  join(root, "web", ".env.local"),
  Object.entries({ ...webEnv, NEXTAUTH_URL: "http://localhost:3000" })
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n",
);
console.log("✓ wrote web/.env.local (for local `npm run dev -w web`)");

// ---------------------------------------------------------------- GitHub

const priv = sh("gh", ["repo", "view", wdashRepo, "--json", "visibility", "-q", ".visibility"]);
if (priv.ok && priv.out === "PRIVATE") {
  const acc = sh("gh", ["api", "-X", "PUT", `repos/${wdashRepo}/actions/permissions/access`, "-f", "access_level=user"]);
  console.log(acc.ok ? `✓ ${wdashRepo}: reusable workflow shared with your other repos` : `✗ couldn't set Actions access on ${wdashRepo}: ${acc.err}`);
}

const repoSecrets = {
  CLAUDE_CODE_OAUTH_TOKEN: state.CLAUDE_CODE_OAUTH_TOKEN,
  WDASH_REDIS_URL: state.WDASH_REDIS_URL,
  WDASH_VAPID_PUBLIC_KEY: state.VAPID_PUBLIC_KEY,
  WDASH_VAPID_PRIVATE_KEY: state.VAPID_PRIVATE_KEY,
  WDASH_WEB_URL: webUrl,
  // Needed because the wdash repo is private: lets the runner check out wdash.
  WDASH_REPO_TOKEN: state.GITHUB_DISPATCH_TOKEN,
};
for (const repo of reposIn.split(",").map((s) => s.trim()).filter(Boolean)) {
  let ok = true;
  for (const [name, value] of Object.entries(repoSecrets)) {
    const r = sh("gh", ["secret", "set", name, "-R", repo], value);
    if (!r.ok) {
      ok = false;
      console.log(`✗ ${repo}: ${name}: ${r.err}`);
    }
  }
  if (ok) console.log(`✓ ${repo}: Actions secrets set`);
}

// ---------------------------------------------------------------- Vercel

if (wantVercel) {
  const who = sh("npx", ["--yes", "vercel", "whoami"]);
  if (!who.ok) {
    console.log("✗ Vercel CLI isn't logged in. Run `npx vercel login`, then `npx vercel link` in this folder, then re-run with --vercel.");
  } else {
    for (const [k, v] of Object.entries(webEnv)) {
      sh("npx", ["--yes", "vercel", "env", "rm", k, "production", "--yes"]);
      const r = sh("npx", ["--yes", "vercel", "env", "add", k, "production"], v);
      console.log(r.ok ? `✓ vercel env ${k}` : `✗ vercel env ${k}: ${r.err.split("\n").pop()}`);
    }
    console.log("Redeploy to apply: npx vercel --prod (or push a commit).");
  }
} else {
  console.log("\nVercel: re-run with --vercel after `npx vercel login && npx vercel link`, or paste the variables in");
  console.log("Project → Settings → Environment Variables. Names:", Object.keys(webEnv).join(", "));
}

// ---------------------------------------------------------------- next steps

console.log(`
Next:
  1. Failover cron: create a job at cron-job.org (or Upstash QStash) hitting
       ${webUrl}/api/cron/reconcile   every 1-2 min
     with header  Authorization: Bearer ${state.CRON_SECRET}
  2. Build and check the daemon:  npm run build -w shared && npm run build -w daemon && node daemon/dist/main.js check
  3. Start it at logon:           powershell -ExecutionPolicy Bypass -File scripts/install-windows-task.ps1
  4. Open ${webUrl}, sign in, Settings → Enable notifications.
`);
