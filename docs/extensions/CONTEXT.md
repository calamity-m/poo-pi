# Context usage

Run `/context` to show the active model window usage without adding anything to message history or triggering an agent turn. In the TUI it opens as a dismissible inline panel in the prompt area with colored category glyphs; in headless modes it prints the same report without ANSI color.

The headline usage and percentage come from Pi's canonical context usage. The category makeup (`System prompt`, `Messages`, `Tool results`, `Summaries`, and `Unknown/overhead`) is an estimate built from the active branch and cached system-prompt data, so use it as a guide for what to trim rather than exact accounting.

```text
anthropic/claude-sonnet-4-5
claude-sonnet-4-5
128k/200k tokens (64%) · OK
───────────────────────────────────────
π π π π π π π π π π π π π π Π Π Π Π Π Π
Π Π Π Π Π Π Π Π Π Π Π Π Π Π Π Π Π Π Π Π
Π Π Π Π Π Π Π Π ϖ ϖ ϖ ϖ ϖ ϖ ϖ ϖ ϖ ϖ ∏ ∏
∏ ∏ ? ? ? ? ? ? · · · · · · · · · · · ·
· · · · · · · · · · · · · · · · · · · ·
───────────────────────────────────────
Estimated usage by category · quality good
  π System prompt: 31k tokens (24%)
  Π Messages: 58k tokens (45%)
  ϖ Tool results: 26k tokens (21%)
  ∏ Summaries: 5.7k tokens (4%)
  ? Unknown/overhead: 7.3k tokens (6%)
  · Free space: 72k (36%)
```

If Pi has no canonical usage yet, or tokens are unknown immediately after compaction, `/context` labels the usage as unknown instead of displaying a misleading `0%`.
