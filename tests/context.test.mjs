import assert from "node:assert/strict";
import test from "node:test";

import { __contextForTest, registerContext } from "../extensions/core/extensions/context.ts";

function build(overrides = {}) {
  return __contextForTest.buildContextReport({
    usage: { tokens: 1000, contextWindow: 2000, percent: 50 },
    model: { provider: "test", id: "model", contextWindow: 2000 },
    systemPrompt: "system prompt",
    branch: [],
    isIdle: true,
    ...overrides,
  });
}

test("/context command does not mutate history or call mutating command actions", async () => {
  let handler;
  const pi = {
    on: () => {},
    registerCommand: (name, definition) => {
      assert.equal(name, "context");
      handler = definition.handler;
    },
  };
  registerContext(pi);

  const branch = [{ type: "message", message: { role: "user", content: "hello", timestamp: 1 } }];
  const throwMutation = () => {
    throw new Error("mutating action called");
  };
  const ctx = {
    hasUI: false,
    model: { provider: "test", id: "model", contextWindow: 4096 },
    getContextUsage: () => ({ tokens: 10, contextWindow: 4096, percent: 0.25 }),
    getSystemPrompt: () => "system",
    isIdle: () => true,
    sessionManager: {
      getBranch: () => branch,
      appendCustomMessageEntry: throwMutation,
    },
    ui: { notify: throwMutation, custom: throwMutation },
    sendMessage: throwMutation,
    fork: throwMutation,
    navigateTree: throwMutation,
    newSession: throwMutation,
    switchSession: throwMutation,
    compact: throwMutation,
    appendCustomMessageEntry: throwMutation,
  };

  const originalLog = console.log;
  const output = [];
  console.log = (text) => output.push(text);
  try {
    const before = ctx.sessionManager.getBranch().length;
    await handler("", ctx);
    assert.equal(ctx.sessionManager.getBranch().length, before);
  } finally {
    console.log = originalLog;
  }
  assert.match(output.join("\n"), /usage/);
});

test("/context uses inline custom UI instead of an overlay popup when UI is available", async () => {
  let handler;
  registerContext({
    on: () => {},
    registerCommand: (_name, definition) => {
      handler = definition.handler;
    },
  });

  const customCalls = [];
  const ctx = {
    hasUI: true,
    model: { provider: "test", id: "model", contextWindow: 4096 },
    getContextUsage: () => ({ tokens: 10, contextWindow: 4096, percent: 0.25 }),
    getSystemPrompt: () => "system",
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
    ui: {
      custom: async (_factory, options) => {
        customCalls.push(options);
      },
    },
  };

  await handler("", ctx);

  assert.deepEqual(customCalls, [undefined]);
});

test("cached system prompt options reset on session replacement", async () => {
  let handler;
  const events = new Map();
  registerContext({
    on: (name, eventHandler) => events.set(name, eventHandler),
    registerCommand: (_name, definition) => {
      handler = definition.handler;
    },
  });

  const ctx = {
    hasUI: false,
    model: { provider: "test", id: "model", contextWindow: 4096 },
    getContextUsage: () => ({ tokens: 100, contextWindow: 4096, percent: 2.4 }),
    getSystemPrompt: () => "fallback system",
    isIdle: () => true,
    sessionManager: { getBranch: () => [] },
  };

  const originalLog = console.log;
  const output = [];
  console.log = (text) => output.push(text);
  try {
    events.get("before_agent_start")({
      systemPromptOptions: {
        cwd: "/repo",
        contextFiles: [{ path: "cached.md", content: "cached body" }],
      },
    });
    await handler("", ctx);
    events.get("session_start")({ type: "session_start", reason: "new" });
    await handler("", ctx);
  } finally {
    console.log = originalLog;
  }

  assert.match(output[0], /context file: cached\.md/);
  assert.doesNotMatch(output[1], /context file: cached\.md/);
  assert.match(output[1], /assembled system prompt/);
});

test("formatter uses Claude-style context grid and resource sections", () => {
  const report = build({
    usage: { tokens: 640, contextWindow: 1000, percent: 64 },
    systemPromptOptions: {
      cwd: "/repo",
      selectedTools: ["read", "bash"],
      contextFiles: [{ path: "AGENTS.md", content: "memory body" }],
      skills: [
        { name: "review", description: "desc", content: "skill body", filePath: "/repo/SKILL.md" },
      ],
    },
    branch: [{ type: "message", message: { role: "user", content: "hello", timestamp: 1 } }],
  });
  const output = __contextForTest.formatContextReport(report).join("\n");
  const coloredOutput = __contextForTest.formatContextReport(report, { color: true }).join("\n");

  assert.doesNotMatch(output, /Context Usage/);
  assert.match(output, /π|Π|·/);
  assert.match(output, /──/);
  assert.doesNotMatch(output, /⛁|⛀|⛶/);
  assert.doesNotMatch(output, /\x1b\[/);
  assert.match(coloredOutput, /\x1b\[/);
  assert.match(output, /Estimated usage by category/);
  assert.match(output, /Tools · loaded in system prompt/);
  assert.match(output, /Memory files · \/memory/);
  assert.match(output, /Skills · \/skills/);
});

test("skills render grouped by source with priority ordering and accented headers", () => {
  const report = build({
    usage: { tokens: 100, contextWindow: 1000, percent: 10 },
    systemPromptOptions: {
      cwd: "/repo",
      skills: [
        {
          name: "deploy",
          description: "d",
          content: "body",
          sourceInfo: { scope: "project", source: "local" },
        },
        {
          name: "grill-me",
          description: "d",
          content: "body body",
          sourceInfo: { scope: "user", source: "local" },
        },
        {
          name: "skill-creator",
          description: "d",
          content: "body",
          sourceInfo: { scope: "temporary", source: "skill-creator" },
        },
      ],
    },
  });
  const plain = __contextForTest.formatContextReport(report).join("\n");
  const colored = __contextForTest.formatContextReport(report, { color: true }).join("\n");

  assert.match(
    report.skills.map((skill) => skill.group).join(","),
    /User|Project|Plugin \(skill-creator\)/,
  );
  assert.ok(plain.indexOf("User") < plain.indexOf("Project"));
  assert.ok(plain.indexOf("Project") < plain.indexOf("Plugin (skill-creator)"));
  assert.match(colored, /\x1b\[32mUser\x1b\[0m/);
});

test("missing system prompt options notes that resource breakdowns are deferred", () => {
  const report = build({ systemPromptOptions: undefined });
  assert.match(report.notes.join(" "), /breakdowns appear after the first agent turn/);
});

test("report distinguishes unavailable, null, and known canonical usage", () => {
  const unavailable = build({ usage: undefined, model: { contextWindow: 1234 } });
  assert.equal(unavailable.canonical.tokens, null);
  assert.equal(unavailable.canonical.contextWindow, 1234);
  assert.match(unavailable.notes.join(" "), /unavailable/);

  const postCompaction = build({ usage: { tokens: null, contextWindow: 2000, percent: null } });
  assert.equal(postCompaction.status, "usage unknown until next model response");
  assert.equal(postCompaction.estimateQuality, "limited");
  assert.match(postCompaction.notes.join(" "), /after compaction/);

  const known = build({ usage: { tokens: 1000, contextWindow: 2000, percent: 50 } });
  assert.equal(known.canonical.tokens, 1000);
  assert.equal(known.status, "OK");
});

test("report reconciles estimates with unknown overhead and over-estimate notes", () => {
  const highUnknown = build({
    usage: { tokens: 10000, contextWindow: 20000, percent: 50 },
    systemPrompt: "x",
    branch: [],
  });
  assert.equal(highUnknown.estimateQuality, "low");
  assert.ok(highUnknown.categories.find((item) => item.id === "unknown").tokens > 5000);

  const over = build({
    usage: { tokens: 5, contextWindow: 100, percent: 5 },
    systemPrompt: "x".repeat(10000),
  });
  assert.match(over.notes.join(" "), /exceed canonical/);
  assert.equal(over.categories.find((item) => item.id === "unknown").tokens, 0);
});

test("branch classification uses active branch entries and entry-level buckets", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "question", timestamp: 1 } },
    { type: "compaction", summary: "old summary" },
    { type: "branch_summary", summary: "side branch summary" },
    { type: "custom_message", customType: "note", content: "custom context" },
    { type: "label", label: "ignored" },
  ];
  const items = __contextForTest.branchItems(branch);
  assert.deepEqual(
    items.map((item) => item.category),
    ["conversation", "summaries", "summaries", "conversation"],
  );
  assert.match(items[3].label, /custom:note/);
});

test("message classification separates tool results from conversation blocks", () => {
  const nested = __contextForTest.messageItems(
    {
      role: "assistant",
      content: [
        { type: "text", text: "I will read" },
        { type: "toolCall", name: "read", arguments: { path: "README.md" } },
        { type: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" }] },
      ],
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
    },
    0,
  );
  assert.deepEqual(
    nested.map((item) => item.category),
    ["tool_results", "conversation"],
  );

  const topLevel = __contextForTest.messageItems(
    {
      role: "toolResult",
      toolName: "bash",
      content: [{ type: "text", text: "stdout" }],
      isError: false,
      timestamp: 1,
    },
    1,
  );
  assert.equal(topLevel[0].category, "tool_results");
});

test("system prompt cache labels hide contents but estimate full cached payload", () => {
  const items = __contextForTest.systemItems(
    {
      cwd: "/repo",
      contextFiles: [{ path: "secret.txt", content: "SECRET CONTENT" }],
      skills: [
        {
          name: "skill-a",
          description: "desc",
          content: "secret skill body",
          filePath: "/repo/SKILL.md",
        },
      ],
    },
    "fallback",
  );
  assert.deepEqual(
    items.map((item) => item.label),
    ["context file: secret.txt", "skill: skill-a"],
  );
  assert.doesNotMatch(items.map((item) => item.label).join(" "), /SECRET|secret skill body/);
  assert.ok(items.every((item) => item.tokens > 0));
});

test("large branch report caps contributors and stays bounded", () => {
  const branch = Array.from({ length: 500 }, (_, index) => ({
    type: "message",
    message: { role: "user", content: `${index}: ${"x".repeat(2000)}`, timestamp: index },
  }));
  const started = performance.now();
  const report = build({ branch, systemPrompt: "" });
  const elapsed = performance.now() - started;
  assert.equal(report.topContributors.length, 5);
  assert.ok(elapsed < 1000, `expected bounded report generation, got ${elapsed}ms`);
});
