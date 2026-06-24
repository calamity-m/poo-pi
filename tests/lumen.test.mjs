import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __lumenForTest } from "../extensions/core/extensions/lumen.ts";

const { hasUncommittedChanges, parseLumenDiffArgs, reviewAndInject } = __lumenForTest;

test("parseLumenDiffArgs lets /lumen and /lumen diff both run lumen diff", () => {
  assert.deepEqual(parseLumenDiffArgs(""), []);
  assert.deepEqual(parseLumenDiffArgs("diff"), []);
  assert.deepEqual(parseLumenDiffArgs(" diff   --cached "), ["--cached"]);
  assert.deepEqual(parseLumenDiffArgs("--cached"), ["--cached"]);
});

test("hasUncommittedChanges detects untracked files", () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-lumen-test-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: repo });
    assert.equal(hasUncommittedChanges(repo), false);

    writeFileSync(join(repo, "new-file.txt"), "review me\n");
    assert.equal(hasUncommittedChanges(repo), true);
  } finally {
    rmSync(repo, { force: true, recursive: true });
  }
});

test("reviewAndInject sends submitted Lumen output as a follow-up user message", async () => {
  const sent = [];
  const notifications = [];
  const tuiCalls = [];
  const deps = {
    clearTerminal: () => tuiCalls.push("clear"),
    isInteractive: () => true,
    hasUncommittedChanges: (cwd) => cwd === "/repo",
    runLumenDiff: (cwd, args) => {
      assert.equal(cwd, "/repo");
      assert.deepEqual(args, ["--cached"]);
      return { status: 0, output: "please fix this", error: null };
    },
  };
  const pi = {
    sendUserMessage: async (content, options) => sent.push({ content, options }),
  };
  const ctx = mockCommandContext({ notifications, tuiCalls });

  await reviewAndInject(pi, ctx, ["--cached"], { silentOnClean: false }, deps);

  assert.deepEqual(tuiCalls, ["stop", "clear", "start", "render"]);
  assert.deepEqual(sent, [{ content: "please fix this", options: { deliverAs: "followUp" } }]);
  assert.deepEqual(notifications, []);
});

test("reviewAndInject reports a clean worktree without opening Lumen", async () => {
  const notifications = [];
  const deps = {
    clearTerminal: () => assert.fail("should not clear terminal for a clean worktree"),
    isInteractive: () => true,
    hasUncommittedChanges: () => false,
    runLumenDiff: () => assert.fail("should not run Lumen for a clean worktree"),
  };
  const pi = { sendUserMessage: async () => assert.fail("should not send a message") };
  const ctx = mockCommandContext({ notifications });

  await reviewAndInject(pi, ctx, [], { silentOnClean: false }, deps);

  assert.deepEqual(notifications, [
    { message: "lumen: no uncommitted changes to review", type: "info" },
  ]);
});

/** Build a minimal command context for reviewAndInject tests. */
function mockCommandContext({ notifications = [], tuiCalls = [] } = {}) {
  return {
    hasUI: true,
    cwd: "/repo",
    ui: {
      notify: (message, type) => notifications.push({ message, type }),
      custom: async (factory) => {
        let result;
        factory(
          {
            stop: () => tuiCalls.push("stop"),
            start: () => tuiCalls.push("start"),
            requestRender: () => tuiCalls.push("render"),
          },
          null,
          null,
          (value) => {
            result = value;
          },
        );
        return result;
      },
    },
  };
}
