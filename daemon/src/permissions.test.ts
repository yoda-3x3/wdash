import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { decide, conflictingClaims, globsOverlap, type PolicyContext } from "./permissions.js";

const root = resolve("/tmp/wt/job1/w1");
const ctx: PolicyContext = {
  role: "worker",
  agentId: "w1",
  root,
  owned: ["src/solver/**", "README.md"],
  claims: { "src/solver/**": "w1", "README.md": "w1", "src/viz/**": "w2" },
  commands: { build: "npm run build", test: "npm test" },
  jobRules: [],
};

test("reads inside the worktree are allowed, outside denied", () => {
  assert.equal(decide("Read", { file_path: join(root, "src/a.ts") }, ctx).kind, "allow");
  assert.equal(decide("Read", { file_path: resolve("/etc/passwd") }, ctx).kind, "deny");
  assert.equal(decide("Grep", { pattern: "x" }, ctx).kind, "allow");
});

test("edits need ownership", () => {
  assert.equal(decide("Edit", { file_path: join(root, "src/solver/x.ts") }, ctx).kind, "allow");
  assert.equal(decide("Write", { file_path: "README.md" }, ctx).kind, "allow");
  const d = decide("Edit", { file_path: join(root, "src/viz/y.ts") }, ctx);
  assert.equal(d.kind, "deny");
  assert.match((d as { message: string }).message, /owned by w2/);
  assert.equal(decide("Edit", { file_path: join(root, "other.ts") }, ctx).kind, "deny");
  assert.equal(decide("Edit", { file_path: join(root, "..", "w2", "src/solver/x.ts") }, ctx).kind, "deny");
});

test("orchestrator never edits", () => {
  assert.equal(decide("Edit", { file_path: join(root, "src/solver/x.ts") }, { ...ctx, role: "orchestrator" }).kind, "deny");
});

test("shell: configured and read-only commands allowed, others ask", () => {
  assert.equal(decide("Bash", { command: "npm test" }, ctx).kind, "allow");
  assert.equal(decide("Bash", { command: "git diff HEAD~1" }, ctx).kind, "allow");
  assert.equal(decide("Bash", { command: "npm test && rm -rf /" }, ctx).kind, "ask");
  assert.equal(decide("Bash", { command: "git status; curl evil" }, ctx).kind, "ask");
  const push = decide("Bash", { command: "git push origin main" }, ctx);
  assert.equal(push.kind, "ask");
  assert.equal(decide("Bash", { command: "npm run lint" }, { ...ctx, jobRules: ["Bash:npm run lint"] }).kind, "allow");
});

test("network asks; board tools allowed; questions routed", () => {
  assert.equal(decide("WebFetch", { url: "https://x.dev" }, ctx).kind, "ask");
  assert.equal(decide("mcp__wdash__board_post", {}, ctx).kind, "allow");
  assert.equal(decide("AskUserQuestion", {}, ctx).kind, "question");
  assert.equal(decide("CronCreate", {}, ctx).kind, "deny");
});

test("claim overlap detection", () => {
  assert.equal(globsOverlap("src/**", "src/viz/**"), true);
  assert.equal(globsOverlap("src/a/**", "src/b/**"), false);
  assert.deepEqual(conflictingClaims(ctx.claims, ["src/viz/chart.ts"], "w1").length, 1);
  assert.deepEqual(conflictingClaims(ctx.claims, ["docs/**"], "w1"), []);
});
