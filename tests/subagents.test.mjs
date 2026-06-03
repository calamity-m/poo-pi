import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { writeCoreSubagentSettings } from "../extensions/core/config/persistence.ts";
import { __subagentsForTest } from "../extensions/core/extensions/subagents.ts";

const fastModel = { provider: "test", id: "fast", baseUrl: "http://127.0.0.1:1" };
const highModel = { provider: "test", id: "high", baseUrl: "http://127.0.0.1:1" };

function createContext(cwd, active = highModel) {
  const models = [fastModel, highModel];
  return {
    cwd,
    model: active,
    modelRegistry: {
      find: (provider, id) =>
        models.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: (model) => Boolean(model),
    },
  };
}

const pi = { getThinkingLevel: () => "medium" };

test("resolveSubagentModel handles raw model override", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-subagents-"));
  try {
    const selection = await __subagentsForTest.resolveSubagentModel(
      { task: "t", model: "test/fast", thinkingLevel: "off" },
      createContext(cwd),
      pi,
    );
    assert.equal(selection.model, fastModel);
    assert.equal(selection.modelId, "test/fast");
    assert.equal(selection.thinkingLevel, "off");
    assert.equal(selection.source, "raw model override");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveSubagentModel handles configured fast/high tiers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-subagents-"));
  try {
    await writeCoreSubagentSettings(cwd, {
      fast: { model: "test/fast", thinkingLevel: "off" },
      high: { model: "test/high", thinkingLevel: "high" },
    });
    const fast = await __subagentsForTest.resolveSubagentModel(
      { task: "t", tier: "fast" },
      createContext(cwd),
      pi,
    );
    const high = await __subagentsForTest.resolveSubagentModel(
      { task: "t", tier: "high" },
      createContext(cwd),
      pi,
    );
    assert.equal(fast.model, fastModel);
    assert.equal(fast.thinkingLevel, "off");
    assert.equal(high.model, highModel);
    assert.equal(high.thinkingLevel, "high");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveSubagentModel falls back to the active parent model and thinking level", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-subagents-"));
  try {
    const selection = await __subagentsForTest.resolveSubagentModel(
      { task: "t" },
      createContext(cwd, highModel),
      pi,
    );
    assert.equal(selection.model, highModel);
    assert.equal(selection.modelId, "test/high");
    assert.equal(selection.thinkingLevel, "medium");
    assert.equal(selection.source, "parent fallback");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
