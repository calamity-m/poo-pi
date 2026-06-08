# Interview

The core interview extension registers the `interview_user` tool, which asks the user several structured single- or multi-choice questions in a temporary TUI and returns their answers. It is for gathering a batch of structured answers before choosing an implementation plan — not for a single clarification that can be asked conversationally. The tool requires interactive UI mode; in headless sessions it returns an error.

## Tool input

Each call takes an optional `title` and a list of `questions`. Each question has a stable `id`, a `title`, a `type` (`single` or `multi`), a list of `options`, and an optional `allowCustom` flag. Each option has a stable `value`, a short `label`, an optional one-line `description`, and an optional `preview` (see below).

```json
{
  "title": "Set up auth",
  "questions": [
    {
      "id": "db",
      "title": "Which database?",
      "type": "single",
      "allowCustom": true,
      "options": [
        {
          "value": "pg",
          "label": "Postgres",
          "description": "Relational, ACID",
          "preview": "CREATE TABLE users (\n  id uuid PRIMARY KEY,\n  email text UNIQUE\n);"
        }
      ]
    }
  ]
}
```

## Navigating the panel

- `↑`/`↓` move between rows; `Enter` or `Space` selects the highlighted option.
- `Tab`/`→` advance to the next question (then the review screen); `Shift+Tab`/`←` go back.
- Selecting a `single`-choice option auto-advances; `multi` toggles each option in place.
- `n` edits free-text notes on the highlighted option; with `allowCustom`, the last row lets the user type a custom answer.
- Each question has a per-question **Chat about this** action (returns control to the agent with the current selection) and a **Submit** action. `Esc` cancels.

## Option previews

Each option may carry an optional `preview` string — code, an ASCII diagram, or plain text — shown for the **currently highlighted** option:

- On terminals **≥100 columns** it renders in a bordered "Preview" box in a right-hand column (~45% of width); on narrower terminals it stacks below the options.
- Content is trimmed and capped at **14 lines**; long lines are truncated to the box width. Empty or whitespace-only previews are ignored, so the field is fully optional and per-option.
- It is plain text only — no markdown rendering, syntax highlighting, scrolling, or line wrapping.

## Result

The tool returns one of three statuses:

- `submitted` — an `answers` array, one entry per question, each with the question `id`, `type`, `selected` option values, optional `custom` text, and optional `notes` keyed by option value.
- `chat` — the user picked **Chat about this** on a question; returns that question's `id`, text, current `selected` values, optional `custom`, and `notes`.
- `cancelled` — the user pressed `Esc`.
