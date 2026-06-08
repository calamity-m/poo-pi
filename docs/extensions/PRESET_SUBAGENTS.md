# Preset subagents

The core subagents extension can bundle named preset agents in `extensions/core/extensions/subagents/agents/*.md`. Each file uses simple frontmatter (`key: value` scalars only; no comments, lists, or nested YAML) plus a markdown body used as role text. Supported keys are `name`, `description`, `tier` (`fast`, `high`, or `any`), `tools` (`none`, `read-only`, or `coding`), and `outputFormat`; explicit `spawn_subagent` parameters override preset defaults. `tier: any` leaves model selection on the normal parent fallback path.
