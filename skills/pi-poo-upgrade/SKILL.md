---
name: pi-poo-upgrade
description: Update this package's Pi peer dependency versions and npm lockfile to the installed Pi version. Use when upgrading poo-pi to match `pi --version`.
---

# Pi Poo Upgrade

Upgrade this repository's Pi package references in `package.json` and `package-lock.json` to a target Pi version, defaulting to the version reported by the local `pi` executable.

## Workflow

1. Confirm you are at the repository root.
   ```bash
   test -f package.json && test -f package-lock.json
   ```
2. Resolve the target version. If the user did not provide one, use:
   ```bash
   pi --version
   ```
3. Update all Pi peer dependencies in `package.json` to the exact target version:
   - `@earendil-works/pi-agent-core`
   - `@earendil-works/pi-ai`
   - `@earendil-works/pi-coding-agent`
   - `@earendil-works/pi-tui`

   Leave `typebox` as `"*"` unless the user explicitly asks otherwise.

4. Regenerate `package-lock.json` instead of hand-editing resolved tarball URLs or integrity hashes:
   ```bash
   npm install --package-lock-only --ignore-scripts
   ```
5. Verify the expected version appears in both files:
   ```bash
   rg '"@earendil-works/pi-(agent-core|ai|coding-agent|tui)": "<target-version>"' package.json package-lock.json
   npm run validate:json
   ```
6. Summarize the changed dependency versions and any validation command results.

## Notes

- Keep the change surgical: do not update unrelated dependencies, package metadata, or resource lists.
- If `npm install --package-lock-only` changes unrelated packages, inspect the diff and call that out before proceeding.
- If `npm install --package-lock-only --ignore-scripts` fails because npm's `min-release-age` policy blocks a newly published Pi version, rerun the lockfile regeneration with `--min-release-age=0` for that command only. Do not treat this as the version being unavailable unless it still fails without the release-age gate.
- If the requested version is not available from npm, stop and report the registry error rather than guessing a nearby version.
