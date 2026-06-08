# Prompt filler

Run `/prompt` to pick a discovered prompt template, fill supported variables, and place the expanded prompt in the editor for review. You can also start from a specific template with `/prompt <template> [args...]`; direct invocation still opens the fill UI so substitutions can be reviewed before sending.

Supported placeholders are `$ARGUMENTS`, `$@`, `$1`, `$2`, ..., `${@:N}`, and `${@:N:L}`. Arguments use simple shell-like splitting with quotes and backslash escapes. Prompt frontmatter support is intentionally limited to simple one-line `key: value` strings such as `description` and `argument-hint`; malformed or unreadable templates are reported as warnings and skipped.
