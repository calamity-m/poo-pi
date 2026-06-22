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
`tool_use`, `tool_result`). `tool_result` blocks arrive under `role: "user"`;
the parser folds each result into its originating `tool_use` message (matched by
`tool_use_id`) so one tool call counts as one tool turn, not two.

Claude Code writes **one JSONL line per content block** of an assistant turn,
repeating the same `message.id` and `usage` on each line. The parser dedupes
usage by message id; naive per-line summing inflates token totals ~2–3x.

- **cancels** — count of `[Request interrupted by user` markers in message text.
- **rejections** — count of `The tool use was rejected` markers (emitted when the
  user declines a permission prompt for a tool call).
- **errors** — `tool_result` blocks with `is_error: true`.

### Codex

Typed lines: `session_meta` (carries `cwd`, `id`, model), `event_msg` (UI/runtime
events), and `response_item` (model turns). Messages come from `response_item` of
type `message`; `developer`/`system` roles are skipped as scaffolding. Tool calls
come from `function_call` / `local_shell_call` / `custom_tool_call` items.

- **cancels** — count of `event_msg` payloads of type `turn_aborted`.
- **rejections** — not reliably recorded in the rollout; shown as n/a in the report.
- **errors** — not separately tracked; shown as n/a in the report.

### Pi

Typed lines: a `session` line (carries `cwd`, `id`) followed by `message` lines.
`message.message.role` is `user`, `assistant`, or `toolResult`; content is a list
of `text` / `thinking` blocks. Assistant turns carry a `stopReason`. Tool turns
are counted from `toolResult` lines only (which carry the tool name and error
status); counting assistant content blocks as well would double-count calls.

- **cancels** — assistant turns with `stopReason == "aborted"` (user interrupt).
- **errors** — assistant turns with `stopReason == "error"` plus `toolResult`
  lines with `isError: true`.
- **rejections** — not distinctly recorded (tool errors are ordinary command
  failures, not permission denials); shown as n/a in the report.

### OpenCode

SQLite. The `session` table uses explicit columns (`id`, `project_id`,
`directory`, timestamps). `message` and `part` rows store a JSON blob in `data`
(`message.data.role`; `part.data.type` of `text`/`tool`). The `permission` table
records approval prompts but keys on `project_id`, not session, so denied prompts
are attributed to that project's first session (approximate).

- **rejections** — `permission` rows whose status is `denied`/`rejected`.
- **errors** — tool parts with `state.status == "error"`.
- **cancels** — not recorded; shown as n/a in the report.

> **Untested locally:** the OpenCode parser was written against the known schema
> but the development machine's `opencode.db` had zero sessions. Validate against
> a populated database before trusting OpenCode numbers, and adjust the `data`
> JSON field names if a newer OpenCode version changes them.

## Counter coverage

Not every agent records every friction counter. `fetch_sessions.py` exports a
`friction_support` map in `sessions.json`, and the report renders "—" (n/a) for
untracked counters so they cannot be misread as zero:

| Agent       | cancels | rejections | errors |
| ----------- | ------- | ---------- | ------ |
| Claude Code | ✓       | ✓          | ✓      |
| Codex       | ✓       | n/a        | n/a    |
| Pi          | ✓       | n/a        | ✓      |
| OpenCode    | n/a     | ✓          | ✓      |

## Durations and windowing

- Each session records both `duration_min` (wall-clock span, end − start) and
  `active_min` (inter-message gaps summed with gaps over 30 minutes capped, so a
  session left open overnight does not count as hours of work). `analyze.py`
  uses active time for all duration statistics.
- The `--days`/`--since` window matches on a session's **last activity**, not its
  start, so long-lived sessions resumed inside the window are included.

## Compaction signals

Compaction (summarizing and pruning earlier context) is detected per agent. Each
parser fills a per-session `{total, auto, manual}` count; Pi additionally records
`threshold` and `overflow` when the bundled core extension has persisted trigger
metadata. The digest header also surfaces compactions so synthesis sub-agents can
correlate them with cross-session threads. When a trigger is not recorded, the
difference (`total - auto - manual`) is treated as unknown-trigger in `analyze.py`.

| Agent       | Marker on disk                                                                              | Auto vs manual?                                                   |
| ----------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Claude Code | `type: "system"`, `subtype: "compact_boundary"`, `compactMetadata.trigger`                  | Yes — `auto` / `manual`                                           |
| Codex       | `event_msg` payload `type: "context_compacted"`                                             | No trigger recorded                                               |
| Pi          | top-level line `type: "compaction"` plus optional custom `poo-pi.compaction-metadata` entry | Yes for new poo-pi sessions — `manual` / `threshold` / `overflow` |
| OpenCode    | assistant `message` row with `summary == true` (boolean)                                    | No trigger recorded                                               |

- **Auto-compaction is the notable signal** (it fires on threshold or context
  overflow mid-task and can silently drop detail). Claude Code records `auto`; new
  poo-pi sessions record Pi's `threshold`/`overflow` reasons and count both as
  `auto`. Older Pi sessions and agents without trigger metadata still show total
  compactions without an auto/manual split.
- OpenCode reuses the `summary` field on _user_ messages for an unrelated diff
  object, so detection requires `role == "assistant"` and `summary is True`.

## Token usage

Token usage is tracked **best-effort** into a per-session `{input, output, cache_read}`
tally (headline "work" = input + output; cache reads are kept separate because they
inflate totals without being new work). It is **not billing-accurate** — accounting
differs per agent and cache semantics vary.

| Agent       | Source                                                                                             | Accumulation                                                                                                                              |
| ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | per-assistant-message `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`) | summed per turn, **deduped by `message.id`** (CC repeats usage on every content-block line)                                               |
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

## Digest truncation

Digests are capped at ~9 KB. Over-budget sessions keep the **head and the tail**
of the conversation (with an explicit "N turns omitted" marker) rather than only
the head — friction, abandonment, and resolution cluster at the end of a session,
so head-only truncation would bias synthesis toward how sessions started.

## Timestamps

Timestamps appear as ISO-8601 strings (Claude Code, Codex, Pi `session`),
epoch milliseconds (Pi message timestamps, OpenCode), or epoch seconds. `_parse_ts`
normalizes all of these to epoch seconds (values above ~1e12 are treated as ms).
`sessions.json` stores UTC ISO strings; `analyze.py` converts to the local
timezone of the analyzing machine before bucketing hours, days, and streaks, so
the "when you work" chart reflects local clock time.
