import assert from "node:assert/strict";
import test from "node:test";

import { __helpForTest } from "../extensions/core/extensions/help.ts";

const { collectCommands, filterCommands, BUILTIN_COMMANDS } = __helpForTest;

/** Build a minimal ExtensionAPI stub exposing only getCommands for collectCommands. */
function api(registered) {
  return { getCommands: () => registered };
}

test("collectCommands merges builtins with registered commands, sorted by name", () => {
  const commands = collectCommands(
    api([{ name: "history", description: "Search messages", source: "extension" }]),
  );

  const names = commands.map((c) => c.name);
  assert.deepEqual(
    [...names],
    [...names].sort((a, b) => a.localeCompare(b)),
  );
  assert.ok(commands.some((c) => c.name === "history" && c.source === "extension"));
  assert.ok(commands.some((c) => c.name === "quit" && c.source === "builtin"));
});

test("collectCommands lets a registered command override a builtin of the same name", () => {
  const commands = collectCommands(
    api([{ name: "settings", description: "Core settings", source: "extension" }]),
  );

  const settings = commands.filter((c) => c.name === "settings");
  assert.equal(settings.length, 1);
  assert.equal(settings[0].source, "extension");
  assert.equal(settings[0].description, "Core settings");
});

test("collectCommands defaults a missing description to an empty string", () => {
  const commands = collectCommands(api([{ name: "thing", source: "prompt" }]));
  assert.equal(commands.find((c) => c.name === "thing").description, "");
});

test("filterCommands matches name and description case-insensitively", () => {
  const all = collectCommands(
    api([{ name: "history", description: "Search old messages", source: "extension" }]),
  );

  assert.ok(filterCommands(all, "HISTORY").some((c) => c.name === "history"));
  assert.ok(filterCommands(all, "old messages").some((c) => c.name === "history"));
  assert.deepEqual(filterCommands(all, "no-such-command"), []);
  assert.equal(filterCommands(all, "").length, all.length);
});

test("filterCommands view modes select builtin vs custom commands", () => {
  const all = collectCommands(
    api([
      { name: "history", description: "Search messages", source: "extension" },
      { name: "skill:foo", description: "A skill", source: "skill" },
    ]),
  );

  const builtins = filterCommands(all, "", "builtin");
  assert.ok(builtins.length > 0);
  assert.ok(builtins.every((c) => c.source === "builtin"));

  const custom = filterCommands(all, "", "custom");
  assert.ok(custom.length > 0);
  assert.ok(custom.every((c) => c.source !== "builtin"));
  assert.ok(custom.some((c) => c.name === "history"));
  assert.ok(custom.some((c) => c.name === "skill:foo"));

  assert.equal(filterCommands(all, "", "default").length, all.length);
});

test("filterCommands combines mode with the text query", () => {
  const all = collectCommands(
    api([{ name: "history", description: "Search messages", source: "extension" }]),
  );

  // "new" matches builtin /new and the description of nothing custom here.
  assert.deepEqual(filterCommands(all, "new", "custom"), []);
  assert.ok(filterCommands(all, "new", "builtin").some((c) => c.name === "new"));
});

test("BUILTIN_COMMANDS includes core session commands", () => {
  const names = BUILTIN_COMMANDS.map((c) => c.name);
  for (const expected of ["new", "resume", "model", "quit"]) {
    assert.ok(names.includes(expected), `expected builtin /${expected}`);
  }
});
