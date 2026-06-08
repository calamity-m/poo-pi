# Session formats & friction signals

How each agent stores sessions on disk and exactly what the `insights-report` friction
counters measure. `fetch_sessions.py` implements one parser per agent, each
emitting the common `Session` / `Message` shape; the rest of the pipeline is
agent-agnostic. To support a new agent, add a parser and register it in
`AGENT_PARSERS`.

## Storage locations

| Agent       | Location                                               | Format                                           |
| ----------- | ------------------------------------------------------ | ------------------------------------------------ |
| Claude Code | `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`        | JSONL, one event per line                        |
| Codex       | `~/.codex/sessions/<Y>/<M>/<D>/rollout-*.jsonl`        | JSONL, typed payload lines                       |
| Pi          | `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl` | JSONL, typed lines                               |
| OpenCode    | `~/.local/share/opencode/opencode.db`                  | SQLite (`session`/`message`/`part`/`permission`) |

## Per-agent parsing notes

### Claude Code

Each line is an event with `message{role, content}`, `cwd`, `gitBranch`, and
`timestamp`. `content` is a string or a list of blocks (`text`, `thinking`,
`tool_use`, `tool_result`). `tool_result` blocks arrive under `role: "user"`, so
the parser reclassifies them as tool turns by inspecting block shape.

- **cancels** — count of `[Request interrupted by user` markers in message text.
- **rejections** — count of `The tool use was rejected` markers (emitted when the
  user declines a permission prompt for a tool call).
- **errors** — not separately tracked for Claude Code.

### Codex

Typed lines: `session_meta` (carries `cwd`, `id`, model), `event_msg` (UI/runtime
events), and `response_item` (model turns). Messages come from `response_item` of
type `message`; `developer`/`system` roles are skipped as scaffolding. Tool calls
come from `function_call` / `local_shell_call` / `custom_tool_call` items.

- **cancels** — count of `event_msg` payloads of type `turn_aborted`.
- **rejections** — not reliably recorded in the rollout; reported as 0.
- **errors** — not separately tracked.

### Pi

Typed lines: a `session` line (carries `cwd`, `id`) followed by `message` lines.
`message.message.role` is `user`, `assistant`, or `toolResult`; content is a list
of `text` / `thinking` blocks. Assistant turns carry a `stopReason`.

- **cancels** — assistant turns with `stopReason == "aborted"` (user interrupt).
- **errors** — assistant turns with `stopReason == "error"`.
- **rejections** — not distinctly recorded (tool errors are ordinary command
  failures, not permission denials); reported as 0.

### OpenCode

SQLite. The `session` table uses explicit columns (`id`, `project_id`,
`directory`, timestamps). `message` and `part` rows store a JSON blob in `data`
(`message.data.role`; `part.data.type` of `text`/`tool`). The `permission` table
records approval prompts but keys on `project_id`, not session, so denied prompts
are attributed to that project's first session (approximate).

- **rejections** — `permission` rows whose status is `denied`/`rejected`.
- **cancels / errors** — best effort; tool parts with `state.status == "error"`
  mark tool errors.

> **Untested locally:** the OpenCode parser was written against the known schema
> but the development machine's `opencode.db` had zero sessions. Validate against
> a populated database before trusting OpenCode numbers, and adjust the `data`
> JSON field names if a newer OpenCode version changes them.

## Compaction signals

Compaction (summarizing and pruning earlier context) is detected per agent. Each
parser fills a per-session `{total, auto, manual}` count; the digest header also
surfaces it so synthesis sub-agents can correlate compactions with cross-session
threads. **Only Claude Code records the trigger**, so for the other agents
`auto`/`manual` stay 0 and the difference (`total - auto - manual`) is treated as
unknown-trigger in `analyze.py`.

| Agent       | Marker on disk                                                             | Auto vs manual?         |
| ----------- | -------------------------------------------------------------------------- | ----------------------- |
| Claude Code | `type: "system"`, `subtype: "compact_boundary"`, `compactMetadata.trigger` | Yes — `auto` / `manual` |
| Codex       | `event_msg` payload `type: "context_compacted"`                            | No trigger recorded     |
| Pi          | top-level line `type: "compaction"` (`tokensBefore`, `fromHook`)           | No trigger recorded     |
| OpenCode    | assistant `message` row with `summary == true` (boolean)                   | No trigger recorded     |

- **Auto-compaction is the notable signal** (it fires on context overflow mid-task
  and can silently drop detail). Because only Claude Code distinguishes it, reports
  flag auto-compaction counts confidently only for Claude Code; for other agents
  the report shows total compactions without an auto/manual split.
- OpenCode reuses the `summary` field on _user_ messages for an unrelated diff
  object, so detection requires `role == "assistant"` and `summary is True`.

## Token usage

Token usage is tracked **best-effort** into a per-session `{input, output, cache_read}`
tally (headline "work" = input + output; cache reads are kept separate because they
inflate totals without being new work). It is **not billing-accurate** — accounting
differs per agent and cache semantics vary.

| Agent       | Source                                                                                             | Accumulation                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | per-assistant-message `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`) | summed per turn                                                                                                                           |
| Pi          | per-assistant-message `message.usage` (`input`, `output`, `cacheRead`)                             | summed per turn                                                                                                                           |
| OpenCode    | per-assistant `message.tokens` (`input`, `output`, `cache.read`)                                   | summed per turn                                                                                                                           |
| Codex       | `event_msg` payload `token_count` → `info.total_token_usage`                                       | **cumulative** — last reading is the session total; `input_tokens` includes cached, so fresh input = `input_tokens − cached_input_tokens` |

- Codex is the odd one out: its `token_count` is a running cumulative total, so the
  parser **assigns** (not sums) from the latest reading. Codex also reports
  `model_context_window`, which is not currently captured.
- Reasoning tokens (Codex `reasoning_output_tokens`, OpenCode `reasoning`) are not
  broken out separately; they fold into the model's reported output where included.

## Boilerplate filtering

Agents inject scaffolding that masquerades as a user turn (environment context,
permission preambles, system reminders, `AGENTS.md` dumps, command caveats). The
parser drops these (via `_BOILERPLATE_PREFIXES`) when choosing the "first user
prompt" and when building digests, so themes reflect what the human actually
asked rather than injected text.

## Timestamps

Timestamps appear as ISO-8601 strings (Claude Code, Codex, Pi `session`),
epoch milliseconds (Pi message timestamps, OpenCode), or epoch seconds. `_parse_ts`
normalizes all of these to epoch seconds (values above ~1e12 are treated as ms).
