import assert from "node:assert/strict";
import test from "node:test";

import { __historySearchForTest } from "../extensions/core/extensions/history-search.ts";

const { entriesToSearchableMessages, messageText, searchMessages } = __historySearchForTest;

/** Build a minimal session message entry for history-search tests. */
function entry(role, content, timestamp) {
  return {
    type: "message",
    id: `${role}-${timestamp}`,
    parentId: null,
    timestamp: new Date(timestamp).toISOString(),
    message: { role, content, timestamp },
  };
}

test("messageText extracts only text blocks from rich content", () => {
  assert.equal(messageText("plain"), "plain");
  assert.equal(
    messageText([
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "world" },
    ]),
    "hello\nworld",
  );
});

test("entriesToSearchableMessages keeps user text only", () => {
  const messages = entriesToSearchableMessages(
    [
      entry("user", "find me", 1000),
      entry("assistant", [{ type: "text", text: "assistant answer" }], 2000),
      entry("toolResult", [{ type: "text", text: "tool output" }], 3000),
    ],
    { sessionPath: "/tmp/session.jsonl", sessionTitle: "Test Session", cwd: "/tmp" },
  );

  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [["user", "find me"]],
  );
});

test("searchMessages is case-insensitive, relevance-ranked, and limited", () => {
  const messages = [
    {
      sessionPath: "a",
      sessionTitle: "A",
      role: "user",
      text: "less relevant needle",
      timestamp: 3000,
    },
    { sessionPath: "b", sessionTitle: "B", role: "user", text: "needle first", timestamp: 1000 },
    { sessionPath: "c", sessionTitle: "C", role: "user", text: "ignored", timestamp: 4000 },
  ];

  const results = searchMessages(messages, "NEEDLE", 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].message.text, "needle first");
  assert.match(results[0].label, /user/);
});
