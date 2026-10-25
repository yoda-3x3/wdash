import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { branchFor, safeFileName, uniqueFileName } from "@wdash/shared";
import * as G from "./git.js";
import { pushRepo, repoDir } from "./otherRepos.js";

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

  // The merged base branch goes to GitHub too.
  assert.equal(await G.pushBase(home, "main"), undefined);
  assert.equal(await G.git(home, "rev-parse", "origin/main"), await G.git(home, "rev-parse", "main"));
});

test("pushing the base branch reports a remote that moved ahead instead of throwing", async () => {
  const { root, origin, home } = await setup();
  const other = join(root, "other");
  await G.git(root, "clone", origin, other);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) await G.git(other, "config", k, v);
  writeFileSync(join(other, "c.txt"), "elsewhere\n");
  await G.git(other, "add", "-A");
  await G.git(other, "commit", "-m", "remote change");
  await G.git(other, "push", "origin", "main");
  writeFileSync(join(home, "d.txt"), "local\n");
  await G.git(home, "add", "-A");
  await G.git(home, "commit", "-m", "local change");
  assert.match((await G.pushBase(home, "main")) ?? "", /has commits your PC doesn't/);
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

test("attachments dir is excluded from worktree commits", async () => {
  const { root, home } = await setup();
  await G.excludeFromGit(home, "/.wdash/");
  await G.excludeFromGit(home, "/.wdash/"); // idempotent
  const w = await G.addWorktree(home, join(root, "wt", "w1"), branchFor.worker("j2", "w1"), "main");
  mkdirSync(join(w, ".wdash", "attachments"), { recursive: true });
  writeFileSync(join(w, ".wdash", "attachments", "spec.pdf"), "pdf");
  writeFileSync(join(w, "c.txt"), "real change");
  await G.checkpointCommit(w, "wip");
  const files = (await G.git(w, "show", "--name-only", "--format=", "HEAD")).split("\n").filter(Boolean);
  assert.deepEqual(files, ["c.txt"]);
  const common = await G.git(home, "rev-parse", "--git-common-dir");
  const exclude = readFileSync(join(home, common, "info", "exclude"), "utf8");
  assert.equal(exclude.split("\n").filter((l) => l === "/.wdash/").length, 1);
});

test("attachment names are made safe and unique", () => {
  assert.equal(safeFileName("C:\\Users\\me\\Report <final>.docx"), "Report _final_.docx");
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("..."), "file");
  assert.equal(uniqueFileName("a.pdf", new Set(["a.pdf", "a (2).pdf"])), "a (3).pdf");
  assert.equal(uniqueFileName("notes", new Set(["notes"])), "notes (2)");
});

test("push_repo commits an opened repo and pushes to its default branch", async () => {
  const { root, origin } = await setup();
  const cwd = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  const dir = repoDir(cwd, "me/other");
  await G.git(root, "clone", origin, dir);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) await G.git(dir, "config", k, v);
  writeFileSync(join(dir, "fix.txt"), "fixed\n");
  const out = await pushRepo(cwd, "me/other", "fix from another job");
  assert.match(out, /Pushed 1 commit/);
  assert.equal(await G.git(dir, "rev-parse", "HEAD"), await G.git(root, "--git-dir", origin, "rev-parse", "main"));
  assert.match(await pushRepo(cwd, "me/other", "again"), /Nothing new/);
  await assert.rejects(pushRepo(cwd, "me/missing", "x"), /isn't open/);
});

test("a finished job merges on GitHub when the PC checkout can't take it, and the PC catches up later", async () => {
  const { root, origin, home } = await setup();
  const job = "j9";
  const main = await G.addWorktree(home, join(root, "wt", "main"), branchFor.main(job), "main");
  writeFileSync(join(main, "job.txt"), "job\n");
  await G.checkpointCommit(main, "job work");

  // Someone else moved GitHub's main ahead meanwhile.
  const other = join(root, "other");
  await G.git(root, "clone", "-c", "core.autocrlf=false", origin, other);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@t"]]) await G.git(other, "config", k, v);
  writeFileSync(join(other, "c.txt"), "elsewhere\n");
  await G.git(other, "add", "-A");
  await G.git(other, "commit", "-m", "remote change");
  await G.git(other, "push", "origin", "main");

  // The PC checkout has uncommitted edits, so it can't take the merge.
  writeFileSync(join(home, "a.txt"), "dirty\n");
  await G.pushBranches(home, [branchFor.main(job)]);
  const local = await G.syncIntoCheckout(home, "main", job);
  assert.equal(local.kind, "needs_merge");

  const out = await G.mergeOnGitHub(main, "main");
  assert.equal(out.kind, "merged");
  await G.git(other, "pull", "--ff-only");
  assert.equal(readFileSync(join(other, "job.txt"), "utf8"), "job\n");
  assert.equal(readFileSync(join(other, "c.txt"), "utf8"), "elsewhere\n");

  // Once the checkout is clean, syncing fast-forwards it to GitHub's main.
  await G.git(home, "checkout", "--", "a.txt");
  const later = await G.syncIntoCheckout(home, "main", job);
  assert.equal(later.kind, "merged");
  assert.equal(await G.git(home, "rev-parse", "main"), await G.git(home, "rev-parse", "origin/main"));
});

test("checkpoints never commit node_modules, .next, or files too big for GitHub", async () => {
  const { root, home } = await setup();
  const wt = await G.addWorktree(home, join(root, "wt", "big"), branchFor.main("jbig"), "main");
  for (const p of G.NEVER_COMMIT) await G.excludeFromGit(home, p);
  mkdirSync(join(wt, "node_modules", "x"), { recursive: true });
  writeFileSync(join(wt, "node_modules", "x", "index.js"), "x\n");
  mkdirSync(join(wt, ".next"), { recursive: true });
  writeFileSync(join(wt, ".next", "build"), "b\n");
  writeFileSync(join(wt, "huge.bin"), "");
  truncateSync(join(wt, "huge.bin"), 96 * 1024 * 1024); // sparse, so the test stays fast
  writeFileSync(join(wt, "app.ts"), "ok\n");
  assert.ok(await G.checkpointCommit(wt, "wip"));
  assert.deepEqual((await G.git(wt, "show", "--name-only", "--format=", "HEAD")).split("\n"), ["app.ts"]);
  // The big file stays out of later checkpoints too.
  writeFileSync(join(wt, "app.ts"), "ok2\n");
  await G.checkpointCommit(wt, "wip2");
  assert.deepEqual((await G.git(wt, "show", "--name-only", "--format=", "HEAD")).split("\n"), ["app.ts"]);
});
