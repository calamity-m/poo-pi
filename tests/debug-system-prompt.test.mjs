import assert from "node:assert/strict";
import test from "node:test";

import {
  __debugSystemPromptForTest,
  registerDebugSystemPrompt,
} from "../extensions/debug/index.ts";

test("/debug-system-prompt opens an overlay popup when UI is available", async () => {
  let handler;
  registerDebugSystemPrompt({
    on: () => {},
    registerCommand: (name, definition) => {
      assert.equal(name, "debug-system-prompt");
      handler = definition.handler;
    },
    getActiveTools: () => ["read"],
    getAllTools: () => [tool("read")],
  });

  const customCalls = [];
  await handler("", {
    hasUI: true,
    model: { provider: "test", id: "model", contextWindow: 1000 },
    getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
    getSystemPrompt: () => "system\nwith tools",
    getSystemPromptOptions: () => ({ cwd: "/repo", selectedTools: ["read"] }),
    ui: {
      custom: async (_factory, options) => {
        customCalls.push(options);
      },
    },
  });

  assert.equal(customCalls.length, 1);
  assert.equal(customCalls[0].overlay, true);
});

test("debug report includes system prompt, additions, tool definitions, and token summary", () => {
  const report = __debugSystemPromptForTest.buildDebugSystemPromptReport(
    {
      getActiveTools: () => ["read"],
      getAllTools: () => [
        tool("read", { source: "builtin" }),
        tool("custom", { source: "extension" }),
      ],
    },
    {
      model: { provider: "test", id: "model", contextWindow: 1000 },
      getContextUsage: () => ({ tokens: 120, contextWindow: 1000, percent: 12 }),
      getSystemPrompt: () => "assembled system prompt",
      getSystemPromptOptions: () => ({
        cwd: "/repo",
        appendSystemPrompt: "extra user extension instruction",
        promptGuidelines: ["Use read first"],
        contextFiles: [{ path: "AGENTS.md", content: "project rules" }],
        toolSnippets: { read: "Read files" },
        skills: [{ name: "review", description: "Review code" }],
      }),
    },
  );

  const output = __debugSystemPromptForTest.formatDebugSystemPromptReport(report).join("\n");
  assert.match(output, /Assembled system prompt/);
  assert.match(output, /assembled system prompt/);
  assert.match(output, /extra user extension instruction/);
  assert.match(output, /All tool definitions/);
  assert.match(output, /### read \(active\)/);
  assert.match(output, /### custom/);
  assert.match(output, /Estimated prompt contributors/);
  assert.match(output, /Context usage: 120\/1\.0k tokens \(12%\)/);
});

test("debug report can use the last turn prompt snapshot when it differs from command context", () => {
  const report = __debugSystemPromptForTest.buildDebugSystemPromptReport(
    { getActiveTools: () => [], getAllTools: () => [] },
    {
      model: undefined,
      getContextUsage: () => undefined,
      getSystemPrompt: () => "base prompt",
      getSystemPromptOptions: () => ({ cwd: "/current" }),
    },
    {
      systemPrompt: "base prompt plus before_agent_start additions",
      options: { cwd: "/captured", appendSystemPrompt: "captured addition" },
    },
  );

  assert.equal(report.snapshot, "last-turn");
  assert.equal(report.options.cwd, "/captured");
  assert.match(
    __debugSystemPromptForTest.formatDebugSystemPromptReport(report).join("\n"),
    /captured addition/,
  );
});

function tool(name, sourceInfo = {}) {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: { path: { type: "string" } } },
    promptGuidelines: [`Use ${name} carefully`],
    sourceInfo: { scope: "temporary", source: "builtin", origin: "top-level", ...sourceInfo },
  };
}
