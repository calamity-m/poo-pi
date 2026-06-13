import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  parseCoreSettings,
  readCoreSettings,
  validateCoreSettings,
  validateSubagentSection,
  validateWorktreeSection,
  writeCoreSettings,
} from "../extensions/core/config/persistence.ts";
import { coreSettingsPath } from "../extensions/core/config/paths.ts";

const validSubagents = {
  fast: { model: "anthropic/claude-haiku", thinkingLevel: "off" },
  high: { model: "anthropic/claude-opus", thinkingLevel: "high" },
};

/** Run a persistence assertion against an isolated Pi agent directory. */
async function withTempAgentDir(fn) {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-settings-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  try {
    await fn(cwd);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(cwd, { recursive: true, force: true });
  }
}

test("parseCoreSettings retains valid subagent mappings", () => {
  assert.deepEqual(
    parseCoreSettings({ version: 1, subagents: validSubagents })?.subagents,
    validSubagents,
  );
});

test("parseCoreSettings retains history search shortcut", () => {
  assert.deepEqual(
    parseCoreSettings({ version: 1, historySearch: { shortcut: "ctrl+r" } })?.historySearch,
    {
      shortcut: "ctrl+r",
    },
  );
});

test("parseCoreSettings retains footer config", () => {
  assert.deepEqual(
    parseCoreSettings({
      version: 1,
      footer: { enabled: false, template: "{model} │ {branch}" },
    })?.footer,
    { enabled: false, template: "{model} │ {branch}" },
  );
});

test("validateSubagentSection rejects unsupported tier names", () => {
  assert.match(validateSubagentSection({ default: { model: "p/m" } }), /not supported/);
});

test("validateSubagentSection rejects invalid canonical model ids", () => {
  assert.match(validateSubagentSection({ fast: { model: "missing-slash" } }), /canonical/);
});

test("validateSubagentSection rejects invalid thinking levels", () => {
  assert.match(
    validateSubagentSection({ fast: { model: "p/m", thinkingLevel: "max" } }),
    /thinking/,
  );
});

test("validateCoreSettings rejects invalid history search shortcut", () => {
  assert.match(
    validateCoreSettings({ version: 1, historySearch: { shortcut: "" } }),
    /historySearch/,
  );
});

test("validateCoreSettings rejects invalid footer config", () => {
  assert.match(validateCoreSettings({ version: 1, footer: { enabled: "yes" } }), /footer/);
  assert.match(validateCoreSettings({ version: 1, footer: { template: "" } }), /footer/);
});

test("validateCoreSettings returns normalized settings with subagents", () => {
  const result = validateCoreSettings({ version: 1, subagents: validSubagents });
  assert.notEqual(typeof result, "string");
  assert.deepEqual(typeof result === "string" ? undefined : result.subagents, validSubagents);
});

test("parseCoreSettings retains a valid worktrees root", () => {
  assert.deepEqual(
    parseCoreSettings({ version: 1, worktrees: { root: "~/.pi/worktrees" } })?.worktrees,
    { root: "~/.pi/worktrees" },
  );
});

test("parseCoreSettings drops an empty worktrees root", () => {
  assert.equal(parseCoreSettings({ version: 1, worktrees: { root: "  " } })?.worktrees, undefined);
});

test("validateWorktreeSection accepts undefined and a valid root", () => {
  assert.equal(validateWorktreeSection(undefined), undefined);
  assert.equal(validateWorktreeSection({ root: "~/.pi/worktrees" }), undefined);
});

test("validateWorktreeSection rejects non-objects and empty roots", () => {
  assert.match(validateWorktreeSection("x"), /worktrees/);
  assert.match(validateWorktreeSection({ root: "" }), /worktrees.root/);
  assert.match(validateWorktreeSection({ root: 5 }), /worktrees.root/);
});

test("core settings path uses the package namespace under the agent dir", async () => {
  await withTempAgentDir(async (cwd) => {
    assert.equal(coreSettingsPath(cwd), join(cwd, "agent", "poo", "core-settings.json"));
  });
});

test("worktrees survive a write round trip with other settings", async () => {
  await withTempAgentDir(async (cwd) => {
    await writeCoreSettings(cwd, {
      version: 1,
      worktrees: { root: "/tmp/managed-worktrees" },
      footer: { enabled: true },
    });
    const settings = await readCoreSettings(cwd);
    assert.deepEqual(settings.worktrees, { root: "/tmp/managed-worktrees" });
    assert.deepEqual(settings.footer, { enabled: true });
  });
});

test("subagents survive a write round trip with other settings", async () => {
  await withTempAgentDir(async (cwd) => {
    await writeCoreSettings(cwd, {
      version: 1,
      proxy: { audit: { redact: "off" } },
      subagents: validSubagents,
      footer: { enabled: false, template: "{model}" },
    });
    const settings = await readCoreSettings(cwd);
    assert.deepEqual(settings.subagents, validSubagents);
    assert.deepEqual(settings.proxy, { audit: { redact: "off" } });
    assert.deepEqual(settings.footer, { enabled: false, template: "{model}" });
  });
});
