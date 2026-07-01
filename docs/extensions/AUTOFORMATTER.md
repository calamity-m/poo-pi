# Autoformatter extension

`extensions/autoformatter/` runs one configured formatter after successful agent `write` and `edit` tool calls. Formatter failures are reported in the tool result, but they do not turn the original file edit into a failed tool call.

## Settings paths

Add an `autoformatter` key to the shared poo-pi core settings files:

- Global: `~/.pi/agent/poo/core-settings.json`
- Project-local: `<cwd>/.pi/poo/core-settings.json`

Project-local formatter commands execute only when the project is trusted and the edited file is inside the current project root. Project rules override matching global languages; unrelated global language rules remain active.

## Schema

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

- `id`: stable name shown in formatter notes.
- `languages`: optional override keys; project rules replace global rules for matching languages.
- `extensions`: dot-prefixed file extensions matched in rule order.
- `command`: executable spawned directly without a shell.
- `args`: argv values; an argument equal to `{file}` is replaced with the absolute file path.
- `cwd`: `"project"` or an absolute path.
- `timeoutMs`: positive integer timeout; defaults to `10000`.

## Examples

Global TypeScript formatting with `oxfmt`:

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

Project-local TypeScript override using ESLint:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "typescript-eslint-fix",
        "languages": ["typescript"],
        "extensions": [".ts", ".tsx"],
        "command": "npx",
        "args": ["eslint", "--fix", "{file}"],
        "cwd": "project",
        "timeoutMs": 15000
      }
    ]
  }
}
```

Rust with `rustfmt`:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "rust-rustfmt",
        "languages": ["rust"],
        "extensions": [".rs"],
        "command": "rustfmt",
        "args": ["{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

Go with `gofmt`:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "go-gofmt",
        "languages": ["go"],
        "extensions": [".go"],
        "command": "gofmt",
        "args": ["-w", "{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

Python with `ruff format`:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "python-ruff-format",
        "languages": ["python"],
        "extensions": [".py"],
        "command": "ruff",
        "args": ["format", "{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

Python with `black`:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "python-black",
        "languages": ["python"],
        "extensions": [".py"],
        "command": "black",
        "args": ["{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

Python with `autopep8`:

```json
{
  "version": 1,
  "autoformatter": {
    "formatters": [
      {
        "id": "python-autopep8",
        "languages": ["python"],
        "extensions": [".py"],
        "command": "autopep8",
        "args": ["--in-place", "{file}"],
        "cwd": "project",
        "timeoutMs": 10000
      }
    ]
  }
}
```

## Operational notes

- Prefer absolute commands or explicit package-manager invocations when PATH differs between shells and Pi.
- Config edited by the agent during a session is ignored until the next Pi session, and a warning is appended to tool results.
- Malformed rules are skipped with warnings. A malformed project config does not disable valid global rules.
- Formatter stdout/stderr is capped in tool details to avoid bloating context.
