import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { __promptForTest, registerPrompt } from "../extensions/core/extensions/prompt.ts";

const sourceInfo = (path) => ({
  path,
  source: "test",
  scope: "temporary",
  origin: "top-level",
});

test("parseFrontmatter supports simple prompt metadata", () => {
  assert.deepEqual(
    __promptForTest.parseFrontmatter("---\ndescription: Say hi\nargument-hint: <name>\n---\nHello")
      .data,
    {
      description: "Say hi",
      "argument-hint": "<name>",
    },
  );
});

test("parseFrontmatter reports malformed simple frontmatter", () => {
  assert.match(
    __promptForTest.parseFrontmatter("---\ndescription Say hi\n---\nHello").warning,
    /unsupported/,
  );
  assert.match(__promptForTest.parseFrontmatter("---\ndescription: Say hi").warning, /no closing/);
});

test("splitArgs handles quotes, escapes, and trailing backslash", () => {
  assert.deepEqual(__promptForTest.splitArgs('one "two words" three\\ four end\\'), [
    "one",
    "two words",
    "three four",
    "end\\",
  ]);
});

test("rawArgsAfterFirstToken preserves quoting and surrounding whitespace after the name", () => {
  assert.equal(__promptForTest.rawArgsAfterFirstToken('greet  "a b" c  '), ' "a b" c  ');
  assert.equal(__promptForTest.rawArgsAfterFirstToken("greet alice"), "alice");
  assert.equal(__promptForTest.rawArgsAfterFirstToken("greet"), "");
});

test("expandPrompt handles raw, positional, missing, double-digit, and slice placeholders", () => {
  const args = "one two three four five six seven eight nine ten";
  assert.equal(
    __promptForTest.expandPrompt("$ARGUMENTS|$@|$1|$3|$10|$99|${@:2:3}|${@:4}", args),
    `${args}|${args}|one|three|ten||two three four|four five six seven eight nine ten`,
  );
});

test("detectFillFields shares raw argument aliases and seeds positional values", () => {
  const fields = __promptForTest.detectFillFields("A $ARGUMENTS B $@ C $2", "one two");
  assert.equal(fields.length, 2);
  assert.deepEqual(fields[0], {
    tokens: ["$ARGUMENTS", "$@"],
    label: "$ARGUMENTS",
    value: "one two",
  });
  assert.deepEqual(fields[1], { tokens: ["$2"], label: "$2", value: "two" });
});

test("searchPrompts filters names, descriptions, and argument hints", () => {
  const prompts = [
    { name: "review", description: "Inspect code", argumentHint: "<path>" },
    { name: "commit", description: "Write git message", argumentHint: "" },
    { name: "explain", description: "Teach a concept", argumentHint: "<topic>" },
  ];

  assert.deepEqual(
    __promptForTest.searchPrompts(prompts, "git").map((prompt) => prompt.name),
    ["commit"],
  );
  assert.deepEqual(
    __promptForTest.searchPrompts(prompts, "TOPIC").map((prompt) => prompt.name),
    ["explain"],
  );
  assert.deepEqual(
    __promptForTest.searchPrompts(prompts, "").map((prompt) => prompt.name),
    ["review", "commit", "explain"],
  );
});

test("PromptPickerComponent scrolls through prompts beyond the rendered window", () => {
  const prompts = Array.from({ length: 12 }, (_item, index) => ({
    name: `prompt-${index}`,
    description: "",
    argumentHint: "",
  }));
  const keybindings = {
    matches: (data, id) => data === "down" && id === "tui.select.down",
  };
  const picker = new __promptForTest.PromptPickerComponent(
    prompts,
    { fg: (_key, text) => text, bold: (text) => text },
    keybindings,
    () => {},
    () => {},
  );

  for (let index = 0; index < 11; index++) picker.handleInput("down");

  const rendered = picker.render(80).join("\n");
  assert.match(rendered, /→ \/prompt-11/);
  assert.doesNotMatch(rendered, /  \/prompt-0/);
});

test("PromptFillEditor resolves filled text without submitting to the agent", () => {
  let submittedText;
  let completedText;
  const editor = new __promptForTest.PromptFillEditor(
    { requestRender: () => {} },
    { name: "greet" },
    "Hello $1",
    [{ tokens: ["$1"], label: "$1", value: "alice" }],
    { fg: (_key, text) => text, bg: (_key, text) => text },
    (text) => {
      completedText = text;
    },
  );
  editor.onSubmit = (text) => {
    submittedText = text;
  };

  editor.handleInput("\r");

  assert.equal(completedText, "Hello alice");
  assert.equal(submittedText, undefined);
});

test("registerPrompt fills the editor via the fallback editor when custom editors are unsupported", async () => {
  const root = await mkdtemp(join(tmpdir(), "poo-pi-prompt-"));
  try {
    const file = join(root, "greet.md");
    await writeFile(
      file,
      "---\ndescription: Greet\nargument-hint: <name>\n---\nHello $1 and $ARGUMENTS\n",
    );

    let handler;
    const pi = {
      registerCommand: (_name, def) => {
        handler = def.handler;
      },
      getCommands: () => [
        { name: "greet", description: "Greet", source: "prompt", sourceInfo: sourceInfo(file) },
      ],
    };
    registerPrompt(pi);

    const editorCalls = [];
    let editorText;
    // A UI where setEditorComponent is a no-op and getEditorComponent never
    // retains the factory, matching RPC/print mode behavior.
    const ctx = {
      hasUI: true,
      ui: {
        notify: () => {},
        select: async () => undefined,
        getEditorComponent: () => undefined,
        setEditorComponent: () => {},
        theme: {},
        editor: async (label, prefill) => {
          editorCalls.push({ label, prefill });
          return `${prefill} world`;
        },
        setEditorText: (text) => {
          editorText = text;
        },
      },
    };

    await handler("greet alice", ctx);

    assert.deepEqual(editorCalls, [{ label: "Arguments for /greet: <name>", prefill: "alice" }]);
    assert.equal(editorText, "Hello alice and alice world");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadPrompts surfaces unreadable, malformed, and duplicate prompt diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "poo-pi-prompt-"));
  try {
    const good = join(root, "good.md");
    const bad = join(root, "bad.md");
    const dup = join(root, "dup.md");
    await writeFile(good, "---\ndescription: Good prompt\nargument-hint: <thing>\n---\nHello $1\n");
    await writeFile(bad, "---\nnot frontmatter\n---\nHello\n");
    await writeFile(dup, "Duplicate\n");

    const result = __promptForTest.loadPrompts([
      { name: "good", description: undefined, source: "prompt", sourceInfo: sourceInfo(good) },
      { name: "bad", description: undefined, source: "prompt", sourceInfo: sourceInfo(bad) },
      { name: "good", description: undefined, source: "prompt", sourceInfo: sourceInfo(dup) },
      {
        name: "missing",
        description: undefined,
        source: "prompt",
        sourceInfo: sourceInfo(join(root, "missing.md")),
      },
      { name: "skip", description: undefined, source: "extension", sourceInfo: sourceInfo(good) },
    ]);

    assert.equal(result.prompts.length, 1);
    assert.deepEqual(result.prompts[0], {
      name: "good",
      description: "Good prompt",
      argumentHint: "<thing>",
      path: good,
      body: "Hello $1",
    });
    assert.equal(result.warnings.length, 3);
    assert.match(result.warnings[0], /unsupported frontmatter/);
    assert.match(result.warnings[1], /duplicate prompt name/);
    assert.match(result.warnings[2], /unable to read/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
