# BIGPLAN: Autoformatter extension

## Plan Overview

Build a standalone `extensions/autoformatter/` Pi extension that runs configured formatters after successful agent `write` and `edit` tool calls. The extension reads an `autoformatter` key from the shared global core settings JSON and, for trusted projects, the shared project-local core settings JSON whose matching language rules replace global rules. Done means a user can configure TypeScript to use `oxfmt` globally, override TypeScript in one project to use an ESLint formatter command, and see formatting results surfaced in the original tool result without making the edit/write call fail solely because formatting failed.

## Risks

- **Agent-editable config escalation** — Formatter config turns JSON into local command execution, so an agent-edited core settings file must not make its `autoformatter` key take effect immediately. Track `write`/`edit` calls to global and project `core-settings.json` paths during the session, ignore the `autoformatter` section from changed files until the next Pi session, and surface a warning in tool results.
- **Command execution safety** — Formatter config executes local commands, including global config. Use `spawn`/`execFile` without a shell, substitute `{file}` only as an argv value, validate `cwd`, and test filenames with spaces or shell metacharacters.
- **Project config trust boundary** — Project-local formatter config can execute arbitrary commands. Only read and honor the `autoformatter` key from `.pi/poo/core-settings.json` when `ctx.isProjectTrusted()` is true and the target file is under `ctx.cwd`; otherwise fall back to global config and surface that project config was ignored.
- **Tool-result timing and parallel edits** — Pi can execute sibling tool calls in parallel, and `tool_result` handlers interleave in completion order. Use Pi's exported `withFileMutationQueue()` for the formatter mutation window so formatter processes serialize with built-in `write`/`edit` work for the same absolute file path.
- **Formatter latency and backpressure** — Each formatted edit loads config and runs a child process before the final tool-result patch is available. Keep a timeout default, coalesce duplicate pending runs for the same file when safe, cap formatter output, and report skipped/coalesced runs so slow formatters do not stall every edit.
- **Formatter command portability** — Commands such as `oxfmt` or `eslint` depend on PATH and project installs. Config should make `cwd`, timeout, and arguments explicit; docs should recommend absolute commands or package-manager invocations when needed, and repeated missing-command or bad-cwd failures should be deduplicated so one bad rule does not flood every edit result.

## Plan Details

### Shared Understanding

- **Goal**: automatically run language-specific formatters after successful agent file writes/edits.
- **In scope**: standalone extension outside `extensions/core/`; `autoformatter` key in the shared core settings JSON; global plus trusted project override; successful `write`/`edit` only; non-blocking formatter failure reporting; tests for config merging and formatter invocation.
- **Out of scope**: formatting files created by `bash`; failing or rolling back the original file edit when formatting fails; interactive prompts on formatter failure; replacing existing repository `npm run format` scripts.
- **Key terms**: "formatter rule" means one JSON rule mapping file extensions/language labels to a command template; "project override" means project rules for a language replace global rules for that language while unrelated global language rules remain active.

### Config Shape

Use the same package-owned core settings files as the bundled core extension, adding an `autoformatter` key that does not conflict with existing settings sections:

- Global: `~/.pi/agent/poo/core-settings.json`
- Project-local: `<cwd>/.pi/poo/core-settings.json`

V1 shape:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "typescript-oxfmt",
        "languages": ["typescript"],
        "extensions": [".ts", ".tsx"],
        "command": "oxfmt",
        "args": ["--write", "{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

Rules match by file extension first. `languages` are stable override keys and display labels; they are not inferred by Pi. A project rule overrides matching global languages, but non-overridden languages from a multi-language global rule remain active by splitting the remaining global rule. For example, a project TypeScript rule overrides only `"typescript"` in a global `["typescript", "javascript"]` rule, leaving an effective global JavaScript rule with the same command. If neither side has `languages`, a project rule with the same `id` replaces the global rule. Effective rules are ordered as project rules first, then remaining global rules. V1 accepts `cwd: "project"` or an absolute path; `"project"` resolves to `ctx.cwd`.

Parse global and project `autoformatter` sections independently while preserving the rest of the shared core settings file. A malformed project `autoformatter` section should not disable valid global rules; malformed individual rules should be skipped with warnings when the surrounding JSON is readable.

### Formatting Flow

```text
tool_result(write/edit)
  if tool failed: return unchanged
  narrow with isWriteToolResult/isEditToolResult, then resolve event.input.path against ctx.cwd
  canonicalize absolute path without requiring it to stay under ctx.cwd
  record if this tool call changed a global/project core-settings.json path
  load global autoformatter settings fresh for this tool result unless that settings file's autoformatter section is disabled this session
  if ctx.isProjectTrusted() and target is under ctx.cwd: load project autoformatter settings and merge language/id overrides unless that settings file's autoformatter section is disabled this session
  select first formatter rule matching file extension from effective ordered rules
  if no rule: append config/security warnings when present, otherwise return unchanged
  enqueue formatter for absolute file path through withFileMutationQueue()
  coalesce duplicate pending formatter work for the same file when safe
  run configured command without shell and with {file} placeholder expanded as argv
  append capped formatter summary/output and any config/security warnings to tool result content/details
  never set isError solely because formatter failed
```

### Critical Files

- `extensions/autoformatter/index.ts` — extension entry point; subscribes to `tool_result` and registers command-free v1 behavior.
- `extensions/autoformatter/config.ts` — JSON loading, validation, merge behavior, and path helpers for the `autoformatter` settings section.
- `extensions/autoformatter/format.ts` — rule matching, command construction, timeout handling, and per-file serialization.
- `extensions/core/config/types.ts` and `extensions/core/config/defaults.ts` — shared core settings schema/defaults gain the optional `autoformatter` key without disturbing existing sections.
- `tests/autoformatter.test.mjs` — focused Node tests for config parsing/merging, rule matching, and tool-result behavior.
- `package.json` — Pi manifest already includes `./extensions`; dry-run packaging should verify `extensions/autoformatter/` is included without extra manifest wiring.
- `README.md` — current resource list and user-facing docs link should mention the new extension.
- `docs/extensions/AUTOFORMATTER.md` — user-facing core settings examples, paths, override rules, and failure behavior.

### Gotchas

- Pi's documented `tool_result` hook can return partial patches for `content`, `details`, and `isError`; implement result updates by returning a patch rather than mutating the event object.
- Use Pi's exported `isWriteToolResult()` and `isEditToolResult()` guards, plus the exported input/detail types, instead of hand-rolling assumptions about built-in tool payloads.
- The formatter process should be spawned directly from the extension, not by invoking the `bash` tool, so formatter execution does not recursively trigger agent tool policies or tool events.
- Use the existing core settings path helpers for global/project config paths; keep the package-owned `poo` subdirectory convention for config ownership.
- Preserve original tool output and append a concise formatter note rather than replacing content the agent expects to read.
- Cap captured formatter stdout/stderr in details so noisy tools do not bloat the agent context.
- Treat malformed config as disabled at the narrowest viable scope with a visible warning, not as a formatter failure for a specific edit.
- On timeout or abort, terminate the formatter process and record the termination reason in formatter details.

## Deliverables

### Deliverable 1. Standalone extension skeleton and config model

Create `extensions/autoformatter/` with a documented entry point and typed config model. The config loader should read the `autoformatter` section from global settings and trusted project settings, validate user-edited JSON defensively, and implement the selected merge rule: project rules replace global rules for matching languages while unrelated global rules remain.

- [x] Create `extensions/autoformatter/index.ts` and register the extension factory outside `extensions/core/`.
- [x] Add typed config interfaces for the shared `autoformatter` core settings key and reuse existing global/project core settings path helpers.
- [x] Implement parser/validator behavior for v1 JSON config, including allowed `cwd` values, malformed-rule isolation, and clear warnings for malformed sections.
- [x] Implement global plus trusted-project merge semantics with partial multi-language splitting and same-`id` replacement for language-less rules.
- [x] Add focused tests for valid config, malformed global/project config isolation, trusted/untrusted project behavior, language override merging, partial multi-language splitting, same-`id` override merging, and fresh config loading on subsequent tool results.

### Deliverable 2. Post-write/edit formatter execution

Wire the extension to Pi's `tool_result` event so successful `write` and `edit` calls trigger formatting for the touched file. Formatting should be serialized per absolute path, time out predictably, and report success/failure in the tool result without making the original edit/write fail solely due to formatter failure.

- [x] Detect successful `write` and `edit` tool results with `isWriteToolResult()`/`isEditToolResult()` and resolve their target paths safely from `event.input.path` and `ctx.cwd`.
- [x] Apply trusted project config only when the target file is under `ctx.cwd`; use global-only rules for files outside the project root.
- [x] Track session-local `write`/`edit` changes to global and project `core-settings.json` paths, ignore only the affected file's `autoformatter` section until the next Pi session, and surface a warning.
- [x] Match the target file to the first effective formatter rule by extension.
- [x] Run formatter commands via direct child process spawning without a shell, with `{file}` placeholder expansion as argv, configured cwd, timeout, output caps, and abort-signal handling.
- [x] Serialize formatter invocations per absolute file path through `withFileMutationQueue()` and coalesce duplicate pending runs where safe.
- [x] Return a `tool_result` patch that appends concise formatter success/failure details plus config/security warnings, including warning-only patches when no formatter rule matches, while preserving original output.
- [x] Deduplicate repeated formatter configuration failures per rule during a session.
- [x] Add tests covering no-match, no-match-with-warning, success, formatter failure, timeout, concurrent same-file edits, duplicate pending run handling, and filenames with spaces/shell metacharacters.

### Deliverable 3. User-facing configuration and operations

Document how users configure the global and project-local `autoformatter` core settings section, including the TypeScript `oxfmt` global example and project-local ESLint override example. V1 intentionally has no command surface; effective behavior is visible through formatter notes appended to edit/write tool results.

- [x] Create `docs/extensions/AUTOFORMATTER.md` with core settings paths, `autoformatter` schema, examples, override semantics, PATH/absolute-command guidance, agent-changed-config warnings, and failure behavior.
- [x] Update `README.md` current resources and extension docs list.
- [x] Run `npm run typecheck`, targeted autoformatter tests, `npm run validate:json`, and `npm run pack:dry-run`.

## Issues

- **2026-07-01 — agent:pi** — Implementation completed: standalone autoformatter extension, core settings schema preservation, formatter execution, tests, and user docs are in place.
- **2026-07-01 — agent:pi** — User clarified that autoformatter can share the existing core settings files as a new non-conflicting `autoformatter` key; plan updated away from separate `autoformatter.json` files.
- **2026-07-01 — agent:pi (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 15 findings; 11 merged into plan after user decisions on agent-edited config safety and partial multi-language override behavior. The largest changes added config-escalation protection, project-root scoping, file-mutation queue usage, warning visibility, and output/backpressure controls.
- **2026-07-01 — agent:pi (adversarial review)** — Plan reviewed by 2 adversarial sub-agents (Risks & Assumptions, Completeness & Scope). 17 findings; 12 merged into plan. The largest changes tightened command execution safety, override precedence, warning reporting, and v1 command scope.
- **2026-07-01 — agent:pi** — Initial plan drafted from user-selected scope: JSON config, successful write/edit triggers only, matching-language project overrides, and non-blocking formatter failures.
