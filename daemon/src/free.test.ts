import { test } from "node:test";
import assert from "node:assert/strict";
import { freeModelName, isFreeModel } from "./free.js";

test("freeModelName maps wdash ids to FreeLLMAPI model names", () => {
  assert.equal(freeModelName("free"), "auto");
  assert.equal(freeModelName("free:auto"), "auto");
  assert.equal(freeModelName("free:auto:fast"), "auto:fast");
  assert.equal(freeModelName("free:"), "auto");
});

test("isFreeModel", () => {
  assert.equal(isFreeModel("free"), true);
  assert.equal(isFreeModel("free:auto"), true);
  assert.equal(isFreeModel("freebie"), false);
  assert.equal(isFreeModel("claude-opus-4-7"), false);
});
