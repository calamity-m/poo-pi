import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  writeCoreSettings,
  writeGlobalCoreSubagentSettings,
} from "../extensions/core/config/persistence.ts";
import { __subagentsForTest } from "../extensions/core/extensions/subagents/index.ts";

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

test("resolveSubagentModel handles globally configured fast/high tiers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-subagents-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
    await writeGlobalCoreSubagentSettings({
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
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("resolveSubagentModel ignores project-local subagent tiers", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-subagents-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
    await writeCoreSettings(cwd, {
      version: 1,
      subagents: { fast: { model: "test/high", thinkingLevel: "high" } },
    });
    await writeGlobalCoreSubagentSettings({
      fast: { model: "test/fast", thinkingLevel: "off" },
    });

    const selection = await __subagentsForTest.resolveSubagentModel(
      { task: "t", tier: "fast" },
      createContext(cwd),
      pi,
    );

    assert.equal(selection.model, fastModel);
    assert.equal(selection.thinkingLevel, "off");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
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

test("resolveSubagentModel supports the default tier as the active parent model", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-subagents-"));
  try {
    const selection = await __subagentsForTest.resolveSubagentModel(
      { task: "t", tier: "default", thinkingLevel: "low" },
      createContext(cwd, fastModel),
      pi,
    );
    assert.equal(selection.model, fastModel);
    assert.equal(selection.modelId, "test/fast");
    assert.equal(selection.thinkingLevel, "low");
    assert.equal(selection.source, "tier default");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("nextRunId assigns NATO names in order with a unique suffix", () => {
  assert.match(__subagentsForTest.nextRunId(0, []), /^alpha-[0-9a-z]{2}$/);
  assert.match(__subagentsForTest.nextRunId(1, []), /^bravo-[0-9a-z]{2}$/);
  // Wraps after the 26-name pool.
  assert.match(__subagentsForTest.nextRunId(26, []), /^alpha-[0-9a-z]{2}$/);

  // Retries the suffix until it avoids ids already in use.
  const taken = new Set();
  for (let i = 0; i < 50; i++) taken.add(__subagentsForTest.nextRunId(0, taken));
  assert.equal(taken.size, 50);
  assert.ok([...taken].every((id) => id.startsWith("alpha-")));
});

test("formatCancellationResult includes notes and partial output", () => {
  const withNotes = __subagentsForTest.formatCancellationResult(
    { id: "sa-1", cancelNotes: "wrong file" },
    "partial answer",
  );
  assert.match(withNotes, /cancelled by the user/);
  assert.match(withNotes, /User notes: wrong file/);
  assert.match(withNotes, /Partial output before cancellation:\npartial answer/);

  const bare = __subagentsForTest.formatCancellationResult({ id: "sa-2" }, "   ");
  assert.match(bare, /cancelled by the user/);
  assert.doesNotMatch(bare, /User notes/);
  assert.doesNotMatch(bare, /Partial output/);
});

test("parsePresetAgentFile reads valid frontmatter and body", () => {
  const preset = __subagentsForTest.parsePresetAgentFile(
    "explorer.md",
    `---\nname: explorer\ndescription: Explore files\ntier: fast\ntools: read-only\noutputFormat: bullets\n---\n\nExplore safely.`,
    "/tmp/explorer.md",
  );
  assert.equal(preset.name, "explorer");
  assert.equal(preset.description, "Explore files");
  assert.equal(preset.tier, "fast");
  assert.equal(preset.tools, "read-only");
  assert.equal(preset.outputFormat, "bullets");
  assert.equal(preset.body, "Explore safely.");
});

test("parsePresetAgentFile rejects invalid metadata", () => {
  assert.throws(
    () =>
      __subagentsForTest.parsePresetAgentFile(
        "bad.md",
        `---\nname: other\n---\nbody`,
        "/tmp/bad.md",
      ),
    /must match/,
  );
  assert.throws(
    () =>
      __subagentsForTest.parsePresetAgentFile(
        "bad.md",
        `---\ntools: all\n---\nbody`,
        "/tmp/bad.md",
      ),
    /invalid tools/,
  );
  assert.throws(
    () =>
      __subagentsForTest.parsePresetAgentFile(
        "bad.md",
        `---\nname: bad\nname: bad\n---\nbody`,
        "/tmp/bad.md",
      ),
    /duplicate frontmatter key/,
  );
  assert.throws(
    () =>
      __subagentsForTest.parsePresetAgentFile("bad.md", `---\n# nope\n---\nbody`, "/tmp/bad.md"),
    /comments are not supported/,
  );
  assert.throws(
    () =>
      __subagentsForTest.parsePresetAgentFile(
        "bad.md",
        `---\ntools:\n  - read\n---\nbody`,
        "/tmp/bad.md",
      ),
    /unsupported frontmatter structure/,
  );
  assert.throws(
    () =>
      __subagentsForTest.parsePresetAgentFile(
        "bad.md",
        `---\nname: bad\n---\n${"x".repeat(__subagentsForTest.MAX_PRESET_BODY_CHARS + 1)}`,
        "/tmp/bad.md",
      ),
    /body exceeds/,
  );
});

test("loadPresetAgents skips malformed presets and supports installed-layout paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "poo-pi-installed-subagents-"));
  try {
    const agentsDir = join(
      root,
      "node_modules",
      "poo-pi",
      "extensions",
      "core",
      "extensions",
      "subagents",
      "agents",
    );
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, "explorer.md"),
      `---\nname: explorer\ndescription: Explore\ntier: any\ntools: read-only\n---\nbody`,
    );
    await writeFile(join(agentsDir, "broken.md"), `---\ntools: nope\n---\nbody`);

    const { presets, warnings } = __subagentsForTest.loadPresetAgents(
      pathToFileURL(`${agentsDir}/`),
    );
    assert.equal(presets.size, 1);
    assert.equal(presets.get("explorer").sourcePath.endsWith("explorer.md"), true);
    assert.equal(warnings.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadPresetAgents treats missing or empty agents directories as zero presets", async () => {
  const root = await mkdtemp(join(tmpdir(), "poo-pi-empty-subagents-"));
  try {
    const missing = __subagentsForTest.loadPresetAgents(pathToFileURL(`${join(root, "missing")}/`));
    assert.equal(missing.presets.size, 0);
    assert.equal(missing.warnings.length, 0);

    const emptyDir = join(root, "agents");
    await mkdir(emptyDir);
    const empty = __subagentsForTest.loadPresetAgents(pathToFileURL(`${emptyDir}/`));
    assert.equal(empty.presets.size, 0);
    assert.equal(empty.warnings.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyPresetAgent merges defaults while explicit params win", () => {
  const presets = new Map([
    [
      "explorer",
      {
        name: "explorer",
        description: "Explore",
        tier: "fast",
        tools: "read-only",
        outputFormat: "bullets",
        body: "preset role",
        sourcePath: "/tmp/explorer.md",
      },
    ],
  ]);
  const merged = __subagentsForTest.applyPresetAgent(
    {
      agent: "explorer",
      task: "do it",
      tier: "high",
      model: "test/high",
      role: "custom role",
      context: "custom context",
      tools: "coding",
      outputFormat: "json",
    },
    presets,
  );
  assert.equal(merged.tier, "high");
  assert.equal(merged.model, "test/high");
  assert.equal(merged.tools, "coding");
  assert.equal(merged.outputFormat, "json");
  assert.equal(merged.role, "preset role\n\ncustom role");
  assert.equal(merged.context, "custom context");
  assert.equal(merged.presetAgentName, "explorer");
});

test("applyPresetAgent treats tier any as parent fallback", () => {
  const presets = new Map([
    [
      "anyone",
      {
        name: "anyone",
        tier: "any",
        body: "preset role",
        sourcePath: "/tmp/anyone.md",
      },
    ],
  ]);
  const merged = __subagentsForTest.applyPresetAgent({ agent: "anyone", task: "do it" }, presets);
  assert.equal(merged.tier, undefined);
});

test("applyPresetAgent supports preset-only, custom-only, and unknown-agent calls", () => {
  const presets = new Map([
    [
      "explorer",
      {
        name: "explorer",
        tier: "fast",
        tools: "read-only",
        body: "preset role",
        sourcePath: "/tmp/explorer.md",
      },
    ],
  ]);
  const presetOnly = __subagentsForTest.applyPresetAgent(
    { agent: "explorer", task: "do it" },
    presets,
  );
  assert.equal(presetOnly.role, "preset role");
  assert.equal(presetOnly.tier, "fast");

  const customOnly = { task: "do it", role: "custom role" };
  assert.equal(__subagentsForTest.applyPresetAgent(customOnly, presets), customOnly);
  assert.throws(
    () => __subagentsForTest.applyPresetAgent({ agent: "missing", task: "do it" }, presets),
    /Available preset agents: explorer/,
  );
});

test("preset prompt order keeps role before context, files, format, and task", () => {
  const prompt = __subagentsForTest.buildSubagentPrompt(
    {
      task: "task text",
      role: "preset role\n\ncustom role",
      context: "custom context",
      files: ["README.md"],
      outputFormat: "bullets",
    },
    ["### README.md\n```\ncontent\n```"],
  );
  assert.ok(prompt.indexOf("Role:\npreset role") < prompt.indexOf("Context:\ncustom context"));
  assert.ok(prompt.indexOf("Context:\ncustom context") < prompt.indexOf("Preloaded files:"));
  assert.ok(prompt.indexOf("Preloaded files:") < prompt.indexOf("Relevant file paths:"));
  assert.ok(prompt.indexOf("Relevant file paths:") < prompt.indexOf("Output format:"));
  assert.ok(prompt.indexOf("Output format:") < prompt.indexOf("Task:\ntask text"));
});
