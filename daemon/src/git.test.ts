import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchFor } from "@wdash/shared";
import * as G from "./git.js";

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "wdash-git-"));
  const origin = join(root, "origin.git");
  const home = join(root, "home");
  await G.git(root, "init", "--bare", "-b", "main", origin);
  await G.git(root, "clone", "-c", "core.autocrlf=false", origin, home);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) await G.git(home, "config", k, v);
  writeFileSync(join(home, "a.txt"), "one\n");
  await G.git(home, "add", "-A");
  await G.git(home, "commit", "-m", "init");
  await G.git(home, "push", "origin", "main");
  return { root, origin, home };
}

test("worker worktree -> checkpoint -> merge into job branch -> sync into checkout", async () => {
  const { root, home } = await setup();
  const job = "j1";
  const base = await G.baseRef(home, "main", "home");
  const main = await G.addWorktree(home, join(root, "wt", "main"), branchFor.main(job), base);
  const w = await G.addWorktree(home, join(root, "wt", "w1"), branchFor.worker(job, "w1"), branchFor.main(job));

  writeFileSync(join(w, "b.txt"), "worker\n");
  const sha = await G.checkpointCommit(w, "wip");
  assert.ok(sha);
  assert.equal(await G.checkpointCommit(w, "nothing"), undefined);

  const d = await G.diffAgainst(w, branchFor.main(job));
  assert.deepEqual(d.files, [{ status: "A", path: "b.txt" }]);

  const m = await G.mergeInto(main, branchFor.worker(job, "w1"), "merge w1");
  assert.equal(m.ok, true);
  await G.pushBranches(home, [branchFor.main(job), branchFor.worker(job, "w1")]);

  const out = await G.syncIntoCheckout(home, "main", job);
  assert.equal(out.kind, "merged");
  assert.equal(readFileSync(join(home, "b.txt"), "utf8"), "worker\n");
});

test("sync refuses a dirty checkout and conflicting merges, leaving the branch", async () => {
  const { root, home } = await setup();
  const job = "j2";
  const main = await G.addWorktree(home, join(root, "wt2", "main"), branchFor.main(job), "main");
  writeFileSync(join(main, "a.txt"), "from job\n");
  await G.checkpointCommit(main, "job edit");

  writeFileSync(join(home, "a.txt"), "local edit\n");
  const dirty = await G.syncIntoCheckout(home, "main", job);
  assert.equal(dirty.kind, "needs_merge");
  assert.match((dirty as { why: string }).why, /uncommitted/);

  await G.git(home, "commit", "-am", "local commit");
  const conflict = await G.syncIntoCheckout(home, "main", job);
  assert.equal(conflict.kind, "needs_merge");
  assert.deepEqual((conflict as { conflicts?: string[] }).conflicts, ["a.txt"]);
  // Checkout left clean after the aborted merge.
  assert.equal(await G.git(home, "status", "--porcelain", "--untracked-files=no"), "");
  assert.equal(readFileSync(join(home, "a.txt"), "utf8"), "local edit\n");
});

test("cloud-style resume: a second clone picks up pushed job branches", async () => {
  const { root, origin, home } = await setup();
  const job = "j3";
  const main = await G.addWorktree(home, join(root, "wt3", "main"), branchFor.main(job), "main");
  const w = await G.addWorktree(home, join(root, "wt3", "w"), branchFor.worker(job, "w"), branchFor.main(job));
  writeFileSync(join(w, "c.txt"), "half done\n");
  await G.checkpointCommit(w, "checkpoint");
  await G.pushBranches(home, [branchFor.main(job), branchFor.worker(job, "w")]);
  void main;

  const cloud = join(root, "cloud");
  await G.git(root, "clone", "-c", "core.autocrlf=false", origin, cloud);
  await G.fetchAll(cloud);
  const w2 = await G.addWorktree(cloud, join(root, "cloudwt", "w"), branchFor.worker(job, "w"), branchFor.main(job));
  assert.equal(readFileSync(join(w2, "c.txt"), "utf8"), "half done\n");
});
