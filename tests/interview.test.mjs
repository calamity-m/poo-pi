import assert from "node:assert/strict";
import test from "node:test";

import { registerInterview } from "../extensions/core/extensions/interview/index.ts";
import {
  padToWidth,
  sideBySide,
  wrapCustomAnswer,
} from "../extensions/core/extensions/interview/layout.ts";
import { InterviewPanel } from "../extensions/core/extensions/interview/panel.ts";

const theme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
};

function createPanel(input) {
  let result;
  const tui = { requestRender: () => {} };
  const panel = new InterviewPanel(input, tui, theme, (value) => (result = value));
  return {
    panel,
    get result() {
      return result;
    },
  };
}

test("registerInterview exposes interview_user tool", () => {
  let tool;
  registerInterview({ registerTool: (definition) => (tool = definition) });

  assert.equal(tool.name, "interview_user");
  assert.equal(tool.label, "Interview User");
  assert.equal(tool.executionMode, "sequential");
  assert.ok(tool.promptGuidelines.some((line) => line.includes("interview_user")));
});

test("interview_user returns an error without interactive UI", async () => {
  let tool;
  registerInterview({ registerTool: (definition) => (tool = definition) });

  const result = await tool.execute("call-1", { questions: [] }, undefined, undefined, {
    hasUI: false,
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires interactive UI mode/);
});

test("padToWidth pads to the requested visible width", () => {
  assert.equal(padToWidth("abc", 5), "abc  ");
  assert.equal(padToWidth("abcdef", 3), "abcdef");
});

test("wrapCustomAnswer wraps long custom answers", () => {
  const lines = wrapCustomAnswer("❯ 1. Type something", "one two three four five", 24);

  assert.ok(lines.length > 1);
  assert.ok(lines[0].startsWith("❯ 1. Type something: "));
  assert.ok(lines.slice(1).every((line) => line.startsWith("   ")));
});

test("sideBySide combines columns with a visible gap", () => {
  const lines = sideBySide(["left"], ["right"], 80);

  assert.equal(lines.length, 1);
  assert.match(lines[0], /^left +right$/);
});

test("InterviewPanel renders the interview title", () => {
  const { panel } = createPanel({
    title: "Planning interview",
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "single",
        options: [{ value: "small", label: "Small" }],
      },
    ],
  });

  assert.ok(panel.render(80).some((line) => line.includes("Planning interview")));
});

test("InterviewPanel submits selected answers", () => {
  const state = createPanel({
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "single",
        options: [{ value: "small", label: "Small" }],
      },
    ],
  });

  state.panel.handleInput(" ");
  state.panel.handleInput(" ");

  assert.deepEqual(state.result, {
    status: "submitted",
    answers: [
      {
        questionId: "scope",
        type: "single",
        selected: ["small"],
        custom: undefined,
        notes: undefined,
      },
    ],
  });
});

test("InterviewPanel treats custom text as exclusive for single-choice questions", () => {
  const state = createPanel({
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "single",
        allowCustom: true,
        options: [{ value: "small", label: "Small" }],
      },
    ],
  });

  state.panel.handleInput(" ");
  state.panel.handleInput("\x1b[D");
  state.panel.handleInput("\x1b[B");
  state.panel.handleInput(" ");
  for (const char of "custom") state.panel.handleInput(char);
  state.panel.handleInput("\r");
  state.panel.handleInput(" ");

  assert.deepEqual(state.result, {
    status: "submitted",
    answers: [
      { questionId: "scope", type: "single", selected: [], custom: "custom", notes: undefined },
    ],
  });
});

test("InterviewPanel can return a chat request for the active question", () => {
  const state = createPanel({
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "multi",
        options: [{ value: "small", label: "Small" }],
      },
    ],
  });

  state.panel.handleInput(" ");
  state.panel.handleInput("\x1b[B");
  state.panel.handleInput(" ");

  assert.deepEqual(state.result, {
    status: "chat",
    questionId: "scope",
    question: "Pick scope",
    selected: ["small"],
    custom: undefined,
    notes: undefined,
  });
});

test("InterviewPanel returns only selected option notes keyed by option value", () => {
  const state = createPanel({
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "single",
        options: [
          { value: "small", label: "Small" },
          { value: "robust", label: "Robust" },
        ],
      },
    ],
  });

  assert.ok(state.panel.render(80).some((line) => line.includes("n to edit notes")));

  state.panel.handleInput("n");
  for (const char of "ignore me") state.panel.handleInput(char);
  state.panel.handleInput("\r");
  state.panel.handleInput("\x1b[B");
  state.panel.handleInput("n");
  for (const char of "ship fast") state.panel.handleInput(char);
  state.panel.handleInput("\r");
  state.panel.handleInput(" ");
  state.panel.handleInput(" ");

  assert.deepEqual(state.result, {
    status: "submitted",
    answers: [
      {
        questionId: "scope",
        type: "single",
        selected: ["robust"],
        custom: undefined,
        notes: { robust: "ship fast" },
      },
    ],
  });
});

test("InterviewPanel returns multiple notes for selected multi-choice options", () => {
  const state = createPanel({
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "multi",
        options: [
          { value: "small", label: "Small" },
          { value: "robust", label: "Robust" },
        ],
      },
    ],
  });

  state.panel.handleInput("n");
  for (const char of "first") state.panel.handleInput(char);
  state.panel.handleInput("\r");
  state.panel.handleInput(" ");
  state.panel.handleInput("\x1b[B");
  state.panel.handleInput("n");
  for (const char of "second") state.panel.handleInput(char);
  state.panel.handleInput("\r");
  state.panel.handleInput(" ");
  state.panel.handleInput("\x1b[B");
  state.panel.handleInput("\x1b[B");
  state.panel.handleInput(" ");
  state.panel.handleInput(" ");

  assert.deepEqual(state.result, {
    status: "submitted",
    answers: [
      {
        questionId: "scope",
        type: "multi",
        selected: ["small", "robust"],
        custom: undefined,
        notes: { small: "first", robust: "second" },
      },
    ],
  });
});

test("InterviewPanel cancels on escape", () => {
  const state = createPanel({
    questions: [
      {
        id: "scope",
        title: "Pick scope",
        type: "single",
        options: [{ value: "small", label: "Small" }],
      },
    ],
  });

  state.panel.handleInput("\x1b");

  assert.deepEqual(state.result, { status: "cancelled" });
});
