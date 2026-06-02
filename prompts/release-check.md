---
description: Check whether this Pi package is ready to publish or install
---

Check whether this Pi package is ready to publish or install.

Verify:

- `package.json` metadata, `pi` manifest, and `pi-package` keyword
- extension imports and runtime dependencies
- skill frontmatter and descriptions
- prompt template frontmatter and arguments
- theme JSON validity and required tokens
- `npm pack --dry-run` output

Return a short pass/fail summary with required fixes.
