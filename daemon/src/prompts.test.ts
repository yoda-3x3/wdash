import { test } from "node:test";
import assert from "node:assert/strict";
import { ProjectConfig, type AgentRecord, type JobRecord } from "@wdash/shared";
import { leadPrompt, orchestratorPrompt, workerPrompt } from "./prompts.js";

const project = ProjectConfig.parse({ name: "p", repo: "o/p", baseBranch: "main", commands: {} });
const job = (extra: Record<string, unknown> = {}) =>
  ({ id: "j1", project: "p", task: "t", workers: "auto", reviewCap: 3, lite: false, shape: "auto", ...extra }) as unknown as JobRecord;
const agent = (extra: Record<string, unknown>) =>
  ({ id: "a", role: "worker", model: "sonnet", name: "a", status: "running", globs: ["src/a/**"], branch: "b", ...extra }) as unknown as AgentRecord;

test("the orchestrator may use leads; a 3-tier job requires them", () => {
  assert.match(orchestratorPrompt(job(), project), /mark a plan item lead: true/);
  assert.match(orchestratorPrompt(job({ shape: "three-tier" }), project), /3-TIER team: you -> leads -> workers/);
  assert.match(orchestratorPrompt(job({ shape: "three-tier", lite: true }), project), /3-TIER job/);
});

test("a lead runs its own small team and reports to the orchestrator", () => {
  const p = leadPrompt(job(), project, agent({ id: "api", role: "lead", globs: ["src/api/**"], parent: "orchestrator" }));
  assert.match(p, /LEAD "api"/);
  assert.match(p, /team_spawn_worker/);
  assert.match(p, /never edit files/);
});

test("a worker names whoever reviews it: its lead, or the orchestrator", () => {
  assert.match(workerPrompt(job(), project, agent({ parent: "api" })), /your lead "api"/);
  assert.match(workerPrompt(job(), project, agent({})), /You report to the orchestrator/);
});
