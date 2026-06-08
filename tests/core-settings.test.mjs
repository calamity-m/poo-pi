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
  writeCoreSettings,
} from "../extensions/core/config/persistence.ts";

const validSubagents = {
  fast: { model: "anthropic/claude-haiku", thinkingLevel: "off" },
  high: { model: "anthropic/claude-opus", thinkingLevel: "high" },
};

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

test("validateCoreSettings returns normalized settings with subagents", () => {
  const result = validateCoreSettings({ version: 1, subagents: validSubagents });
  assert.notEqual(typeof result, "string");
  assert.deepEqual(typeof result === "string" ? undefined : result.subagents, validSubagents);
});

test("subagents survive a write round trip with other settings", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "poo-pi-settings-"));
  try {
    await writeCoreSettings(cwd, {
      version: 1,
      proxy: { audit: { redact: "off" } },
      subagents: validSubagents,
    });
    const settings = await readCoreSettings(cwd);
    assert.deepEqual(settings.subagents, validSubagents);
    assert.deepEqual(settings.proxy, { audit: { redact: "off" } });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
