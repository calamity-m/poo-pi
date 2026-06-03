import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

import { deriveBashPatterns } from "./bash.ts";
import { decide, isBashEnvAccess, isEnvBasename } from "./policy.ts";
import { addGrant, writePermissionState } from "./persistence.ts";
import type {
  BashTarget,
  CompiledGrant,
  OtherTarget,
  PathTarget,
  PermissionState,
  ResolvedTarget,
} from "./types.ts";

// ── Mutex ─────────────────────────────────────────────────────────────────────

/**
 * Simple serial queue ensuring at most one prompt dialog is open at a time.
 * Auto-allow/deny decisions bypass the mutex and remain fully parallel.
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Run `fn` exclusively — subsequent calls queue behind the current `fn`. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => fn());
    // Advance the tail whether fn succeeds or fails so the queue never stalls.
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

// ── Path normalization ────────────────────────────────────────────────────────

/**
 * Resolve a raw path input to an absolute real path.
 * For new files (path does not yet exist), walks up to the nearest existing ancestor
 * and re-appends the unresolved suffix so `write` to a new in-cwd file works.
 */
async function normalizePath(rawPath: string, cwd: string): Promise<string> {
  const abs = resolve(cwd, rawPath);
  try {
    return await realpath(abs);
  } catch {
    // Walk up the tree until we find an existing ancestor, then re-append the suffix.
    let current = abs;
    const parts: string[] = [];
    for (;;) {
      const parent = dirname(current);
      if (parent === current) break; // filesystem root — give up
      parts.unshift(basename(current));
      current = parent;
      try {
        const resolved = await realpath(current);
        return join(resolved, ...parts);
      } catch {
        continue;
      }
    }
    return abs; // last resort: absolute but unresolved
  }
}

// ── Target mapping ────────────────────────────────────────────────────────────

/**
 * Map a `ToolCallEvent` to a normalized `ResolvedTarget`.
 * Path targets have symlinks resolved via nearest-existing-parent fallback.
 * Unknown/custom tools are classified as `"other"` (defaults to ask in safe/trusted).
 */
export async function mapTargetAndNormalize(
  event: ToolCallEvent,
  cwd: string,
): Promise<ResolvedTarget> {
  // Bash
  if (isToolCallEventType("bash", event)) {
    const command = event.input.command;
    return {
      kind: "bash",
      command,
      isEnvAccess: isBashEnvAccess(command),
    } satisfies BashTarget;
  }

  // Path tools — each has its own field name per the Pi tool schemas
  let rawPath: string | undefined;
  if (isToolCallEventType("read", event)) rawPath = event.input.path;
  else if (isToolCallEventType("write", event)) rawPath = event.input.path;
  else if (isToolCallEventType("edit", event)) rawPath = event.input.path;
  else if (isToolCallEventType("grep", event)) rawPath = event.input.path;
  else if (isToolCallEventType("find", event)) rawPath = event.input.path;
  else if (isToolCallEventType("ls", event)) rawPath = event.input.path;

  if (rawPath !== undefined || isKnownPathTool(event.toolName)) {
    // For optional path fields (grep/find/ls), undefined means cwd
    const effectivePath = rawPath ?? cwd;
    const resolvedPath = await normalizePath(effectivePath, cwd);
    return {
      kind: "path",
      rawPath: effectivePath,
      resolvedPath,
      isEnv: isEnvBasename(basename(resolvedPath)),
    } satisfies PathTarget;
  }

  // Custom / unknown tool
  return { kind: "other", toolName: event.toolName } satisfies OtherTarget;
}

/** Known path-based built-in tool names. */
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);

function isKnownPathTool(toolName: string): boolean {
  return PATH_TOOLS.has(toolName);
}

// ── Grant derivation ─────────────────────────────────────────────────────────

/**
 * Derive "Always For This Project" grants from a resolved target.
 * - Path tools: one grant with a directory prefix covering the target's parent dir.
 * - Bash: one grant per distinct segment (flag-stop derived pattern, deduped).
 *   A compound command like `npm run build && npm install` produces two grants.
 */
function deriveGrant(toolName: string, target: ResolvedTarget): CompiledGrant[] {
  if (target.kind === "path") {
    const dirPrefix = dirname(target.resolvedPath);
    return [{ tool: toolName, dirPrefix }];
  }
  if (target.kind === "bash") {
    const patterns = deriveBashPatterns(target.command);
    const grants: CompiledGrant[] = [];
    for (const pattern of patterns) {
      try {
        grants.push({ tool: toolName, pattern, regex: new RegExp(pattern) });
      } catch {
        // Invalid derived pattern — skip (shouldn't happen with the deriver)
      }
    }
    return grants;
  }
  return [];
}

// ── Prompt dialog ─────────────────────────────────────────────────────────────

/**
 * Drive the Once / Always For This Project / Deny dialog.
 * Must be called inside the prompt mutex.
 * Treats `select` returning `undefined` (cancel/abort/escape) as Deny.
 */
export async function askOperator(
  ctx: ExtensionContext,
  state: PermissionState,
  toolName: string,
  target: ResolvedTarget,
): Promise<ToolCallEventResult | undefined> {
  const label = targetLabel(toolName, target);
  const choice = await ctx.ui.select(
    `Allow ${label}?`,
    ["Only Once", "Always For This Project", "Deny"],
    { signal: ctx.signal },
  );

  if (choice === "Only Once") {
    // Allow this call, remember nothing
    return undefined;
  }

  if (choice === "Always For This Project") {
    const grants = deriveGrant(toolName, target);
    if (grants.length === 0) return undefined;

    if (target.kind === "bash") {
      // Multi-line editor: one pattern per line for compound commands.
      const prefill = grants.map((g) => g.pattern ?? "").join("\n");
      const edited = await ctx.ui.editor(
        "Edit remembered command rule(s) — one regex per line",
        prefill,
      );
      if (edited === undefined) return undefined; // user cancelled → Only Once

      const lines = edited
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length === 0) return undefined; // operator cleared everything → Only Once

      // Validate all lines before saving — reject the whole batch if any line is invalid.
      const compiled: CompiledGrant[] = [];
      for (const line of lines) {
        try {
          compiled.push({ tool: toolName, pattern: line, regex: new RegExp(line) });
        } catch {
          ctx.ui.notify(
            `[permissions] grant rejected — invalid regex: ${line} (not saved; call is Only Once)`,
            "error",
          );
          return undefined;
        }
      }
      for (const g of compiled) addGrant(state, g);
    } else {
      // Path tool: single directory-prefix grant, no editor
      for (const g of grants) addGrant(state, g);
    }

    await writePermissionState(ctx.cwd, state);
    return undefined;
  }

  // Deny (explicit "Deny" or undefined from cancel/escape)
  const note = await ctx.ui.input("Reason for denying (optional)", "", { signal: ctx.signal });
  return { block: true, reason: note || "denied by operator" };
}

/** Build a short human-readable label for the permission dialog. */
function targetLabel(toolName: string, target: ResolvedTarget): string {
  if (target.kind === "path") return `${toolName} on ${target.rawPath}`;
  if (target.kind === "bash") return `bash: ${target.command.slice(0, 60)}`;
  return `${target.toolName}`;
}

// ── tool_call handler ────────────────────────────────────────────────────────

/**
 * Build the `tool_call` event handler that enforces the active permission policy.
 *
 * The entire decision is wrapped in try/catch; on internal error it fails open
 * (like `open` mode) except for a known direct `.env` path-tool target which
 * is still denied. Notifies the operator at most once per process on degraded state.
 *
 * Headless sessions (`!ctx.hasUI`) always behave as `open` mode regardless of the
 * persisted mode (safe, trusted, open, or permissive) — no gating of write/bash/etc.,
 * only the `.env` path-tool default-deny still applies.
 *
 * @param state - Process-global permission state (mutated on "Always" grants).
 * @param mutex - Shared prompt mutex to serialize concurrent ask dialogs.
 * @param notifiedRef - Single-element tuple holding the per-process "degraded notified" flag.
 */
export function buildToolCallHandler(
  state: PermissionState,
  mutex: Mutex,
  notifiedRef: [boolean],
): (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | undefined> {
  return async (event, ctx) => {
    try {
      const target = await mapTargetAndNormalize(event, ctx.cwd);
      // Headless sessions behave as open mode by design (documented decision).
      const mode = ctx.hasUI ? state.mode : "open";
      const d = decide(mode, state.rules, state.remembered, event.toolName, target, ctx.cwd);

      if (d === "allow") return undefined;
      if (d === "deny") return { block: true, reason: denyReason(target) };

      // d === "ask" — only reachable when hasUI (headless runs as open → never "ask")
      return await mutex.run(() => askOperator(ctx, state, event.toolName, target));
    } catch (err) {
      // Internal error: fail open like open mode, but still deny known direct .env path targets
      if (!notifiedRef[0]) {
        notifiedRef[0] = true;
        ctx.ui.notify(
          `[permissions] internal error (${err instanceof Error ? err.message : String(err)}); running as open mode`,
          "warning",
        );
      }
      if (isKnownDirectEnvPathEvent(event)) {
        return { block: true, reason: ".env access blocked by permissions (degraded)" };
      }
      return undefined;
    }
  };
}

/** Build the prompt mutex for a registerPermissions call. */
export function createMutex(): Mutex {
  return new Mutex();
}

/** Check whether a ToolCallEvent looks like a direct .env path-tool access (best-effort). */
function isKnownDirectEnvPathEvent(event: ToolCallEvent): boolean {
  let rawPath: string | undefined;
  if (isToolCallEventType("read", event)) rawPath = event.input.path;
  else if (isToolCallEventType("write", event)) rawPath = event.input.path;
  else if (isToolCallEventType("edit", event)) rawPath = event.input.path;
  else if (isToolCallEventType("ls", event)) rawPath = event.input.path;
  else if (isToolCallEventType("grep", event)) rawPath = event.input.path;
  else if (isToolCallEventType("find", event)) rawPath = event.input.path;
  if (rawPath !== undefined) return isEnvBasename(basename(rawPath));
  return false;
}

/** Human-readable deny reason for a target. */
function denyReason(target: ResolvedTarget): string {
  if (target.kind === "path" && target.isEnv) return ".env access denied by permissions";
  if (target.kind === "path") return `path denied by permissions: ${target.rawPath}`;
  if (target.kind === "bash") return "bash command denied by permissions";
  return "tool call denied by permissions";
}
