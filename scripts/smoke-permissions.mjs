#!/usr/bin/env node
// Smoke test for the core permissions extension (Deliverables 1 & 2).
//
// Tests the pure policy engine + persistence layer with synthetic inputs, then
// exercises the enforcement handler's concurrency + headless paths.
//
// Does NOT require a running Pi process or filesystem interaction beyond a tmpdir.

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askOperator,
  buildToolCallHandler,
  createMutex,
} from "../extensions/core/extensions/permissions/enforcement.ts";
import {
  decide,
  isBashEnvAccess,
  isEnvBasename,
  isWithinDir,
} from "../extensions/core/extensions/permissions/policy.ts";
import {
  parseAndCompile,
  readPermissionState,
  validateConfig,
  writePermissionState,
} from "../extensions/core/extensions/permissions/persistence.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.error(
      `  ✗ ${message} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
  }
}

/** Build a compiled state from raw config shapes. */
function makeState({ mode = "trusted", rules = [], remembered = [] } = {}) {
  return parseAndCompile({ mode, rules, remembered });
}

/** Synthetic path target. */
function pathTarget(resolvedPath, isEnv) {
  return {
    kind: "path",
    rawPath: resolvedPath,
    resolvedPath,
    isEnv: isEnv ?? isEnvBasename(resolvedPath.split("/").at(-1) ?? ""),
  };
}

/** Synthetic bash target. */
function bashTarget(command) {
  return { kind: "bash", command, isEnvAccess: isBashEnvAccess(command) };
}

/** Synthetic other target. */
function otherTarget(toolName) {
  return { kind: "other", toolName };
}

const CWD = "/project";
const IN_CWD = "/project/src/file.ts";
const OUTSIDE_CWD = "/other/file.ts";
const ENV_PATH = "/project/.env";
const ENV_EXAMPLE_PATH = "/project/.env.example";

// ── Section 1: helpers ────────────────────────────────────────────────────────
console.log("\n1. Helper functions");

assert(isEnvBasename(".env"), "isEnvBasename('.env')");
assert(isEnvBasename(".env.local"), "isEnvBasename('.env.local')");
assert(isEnvBasename(".env.example"), "isEnvBasename('.env.example')");
assert(!isEnvBasename("env"), "!isEnvBasename('env')");
assert(!isEnvBasename(".environment"), "!isEnvBasename('.environment')");

assert(isWithinDir("/project/src/a.ts", "/project"), "isWithinDir within project");
assert(isWithinDir("/project", "/project"), "isWithinDir equal");
assert(
  !isWithinDir("/project2/src", "/project"),
  "!isWithinDir with prefix-only match (no seg boundary)",
);
assert(!isWithinDir("/other", "/project"), "!isWithinDir outside");

assert(isBashEnvAccess("cat .env"), "isBashEnvAccess 'cat .env'");
assert(!isBashEnvAccess("cat .env.example"), "!isBashEnvAccess 'cat .env.example'");
assert(!isBashEnvAccess("echo hello"), "!isBashEnvAccess 'echo hello'");

// ── Section 2: open mode ─────────────────────────────────────────────────────
console.log("\n2. open mode");

{
  const state = makeState({ mode: "open" });

  // open allows everything except .env
  assertEqual(
    decide("open", state.rules, state.remembered, "write", pathTarget(IN_CWD, false), CWD),
    "allow",
    "open: write to cwd → allow",
  );
  assertEqual(
    decide("open", state.rules, state.remembered, "bash", bashTarget("rm -rf /"), CWD),
    "allow",
    "open: destructive bash → allow (open ignores rules)",
  );

  // .env denied in open mode
  assertEqual(
    decide("open", state.rules, state.remembered, "read", pathTarget(ENV_PATH, true), CWD),
    "deny",
    "open: read .env → deny (default-deny)",
  );

  // .env overrideable by explicit config allow
  const stateWithAllow = makeState({
    mode: "open",
    rules: [{ tool: "*", action: "allow", pattern: "\\.env$" }],
  });
  assertEqual(
    decide(
      "open",
      stateWithAllow.rules,
      stateWithAllow.remembered,
      "read",
      pathTarget(ENV_PATH, true),
      CWD,
    ),
    "allow",
    "open: .env with explicit allow rule → allow",
  );

  // .env.example allowed via rule
  const stateWithExample = makeState({
    mode: "open",
    rules: [{ tool: "*", action: "allow", pattern: "\\.env\\.example$" }],
  });
  assertEqual(
    decide(
      "open",
      stateWithExample.rules,
      stateWithExample.remembered,
      "read",
      pathTarget(ENV_EXAMPLE_PATH, true),
      CWD,
    ),
    "allow",
    "open: .env.example with allow rule → allow",
  );
}

// ── Section 3: safe mode ─────────────────────────────────────────────────────
console.log("\n3. safe mode");

{
  const state = makeState({ mode: "safe" });

  // Read-family → allow
  for (const tool of ["read", "grep", "ls", "find"]) {
    assertEqual(
      decide("safe", state.rules, state.remembered, tool, pathTarget(IN_CWD, false), CWD),
      "allow",
      `safe: ${tool} on in-cwd path → allow`,
    );
  }

  // Write/edit/bash → ask
  assertEqual(
    decide("safe", state.rules, state.remembered, "write", pathTarget(IN_CWD, false), CWD),
    "ask",
    "safe: write → ask",
  );
  assertEqual(
    decide("safe", state.rules, state.remembered, "bash", bashTarget("git status"), CWD),
    "ask",
    "safe: bash → ask",
  );
  assertEqual(
    decide("safe", state.rules, state.remembered, "websearch", otherTarget("websearch"), CWD),
    "ask",
    "safe: custom tool → ask",
  );

  // .env → deny even in safe mode
  assertEqual(
    decide("safe", state.rules, state.remembered, "read", pathTarget(ENV_PATH, true), CWD),
    "deny",
    "safe: read .env → deny",
  );

  // Config deny overrides mode default allow (read is normally allowed in safe)
  const stateWithDeny = makeState({
    mode: "safe",
    rules: [{ tool: "read", action: "deny", pattern: "\\.ts$" }],
  });
  assertEqual(
    decide(
      "safe",
      stateWithDeny.rules,
      stateWithDeny.remembered,
      "read",
      pathTarget(IN_CWD, false),
      CWD,
    ),
    "deny",
    "safe: config deny overrides read allow",
  );

  // Config allow lifts write from ask to allow
  const stateWithAllow = makeState({
    mode: "safe",
    rules: [{ tool: "write", action: "allow", pattern: "\\.ts$" }],
  });
  assertEqual(
    decide(
      "safe",
      stateWithAllow.rules,
      stateWithAllow.remembered,
      "write",
      pathTarget(IN_CWD, false),
      CWD,
    ),
    "allow",
    "safe: config allow lifts write to allow",
  );

  // Remembered grant lifts write to allow
  const stateWithGrant = makeState({ mode: "safe" });
  stateWithGrant.remembered.push({ tool: "write", dirPrefix: "/project/src" });
  assertEqual(
    decide(
      "safe",
      stateWithGrant.rules,
      stateWithGrant.remembered,
      "write",
      pathTarget(IN_CWD, false),
      CWD,
    ),
    "allow",
    "safe: remembered dir grant lifts write to allow",
  );
}

// ── Section 4: trusted mode ──────────────────────────────────────────────────
console.log("\n4. trusted mode");

{
  const state = makeState({ mode: "trusted" });

  // Path tools within CWD → allow
  for (const tool of ["read", "write", "edit", "grep", "ls", "find"]) {
    assertEqual(
      decide("trusted", state.rules, state.remembered, tool, pathTarget(IN_CWD, false), CWD),
      "allow",
      `trusted: ${tool} in cwd → allow`,
    );
  }

  // Path tools outside CWD → ask
  assertEqual(
    decide("trusted", state.rules, state.remembered, "read", pathTarget(OUTSIDE_CWD, false), CWD),
    "ask",
    "trusted: read outside cwd → ask",
  );

  // Bash allow patterns → allow
  assertEqual(
    decide("trusted", state.rules, state.remembered, "bash", bashTarget("git status"), CWD),
    "allow",
    "trusted: bash 'git status' → allow",
  );
  assertEqual(
    decide("trusted", state.rules, state.remembered, "bash", bashTarget("ls -la"), CWD),
    "allow",
    "trusted: bash 'ls -la' → allow",
  );
  assertEqual(
    decide("trusted", state.rules, state.remembered, "bash", bashTarget("npm run build"), CWD),
    "allow",
    "trusted: bash 'npm run build' → allow",
  );

  // Bash deny patterns → deny
  assertEqual(
    decide("trusted", state.rules, state.remembered, "bash", bashTarget("rm -rf /tmp/test"), CWD),
    "deny",
    "trusted: bash 'rm -rf' → deny",
  );

  // Unrecognized bash → ask
  assertEqual(
    decide(
      "trusted",
      state.rules,
      state.remembered,
      "bash",
      bashTarget("curl https://example.com"),
      CWD,
    ),
    "ask",
    "trusted: unrecognized bash → ask",
  );

  // .env → deny in trusted mode
  assertEqual(
    decide("trusted", state.rules, state.remembered, "read", pathTarget(ENV_PATH, true), CWD),
    "deny",
    "trusted: read .env → deny",
  );

  // Symlink escape: resolved path outside CWD → ask (not allow)
  assertEqual(
    decide(
      "trusted",
      state.rules,
      state.remembered,
      "read",
      pathTarget("/other/resolved", false),
      CWD,
    ),
    "ask",
    "trusted: symlink escaping cwd → ask (containment on resolved path)",
  );

  // Custom tool → ask
  assertEqual(
    decide("trusted", state.rules, state.remembered, "websearch", otherTarget("websearch"), CWD),
    "ask",
    "trusted: custom tool → ask",
  );

  // Bash remembered grant (pattern)
  const stateWithGrant = makeState({ mode: "trusted" });
  stateWithGrant.remembered.push({ tool: "bash", pattern: "^curl\\b", regex: /^curl\b/ });
  assertEqual(
    decide(
      "trusted",
      stateWithGrant.rules,
      stateWithGrant.remembered,
      "bash",
      bashTarget("curl https://example.com"),
      CWD,
    ),
    "allow",
    "trusted: bash with remembered pattern grant → allow",
  );
}

// ── Section 5: config rule precedence ────────────────────────────────────────
console.log("\n5. config rule precedence");

{
  // Config ASK rule checked before mode default allow
  const stateAsk = makeState({
    mode: "trusted",
    rules: [{ tool: "read", action: "ask", pattern: "secrets" }],
  });
  assertEqual(
    decide(
      "trusted",
      stateAsk.rules,
      stateAsk.remembered,
      "read",
      pathTarget("/project/secrets/file", false),
      CWD,
    ),
    "ask",
    "config ask rule overrides trusted allow for path in cwd",
  );

  // Config DENY wins over config ALLOW (deny is step 2, allow is step 4)
  const stateDenyWins = makeState({
    mode: "trusted",
    rules: [
      { tool: "bash", action: "deny", pattern: "^git\\b" },
      { tool: "bash", action: "allow", pattern: "^git\\b" },
    ],
  });
  assertEqual(
    decide(
      "trusted",
      stateDenyWins.rules,
      stateDenyWins.remembered,
      "bash",
      bashTarget("git status"),
      CWD,
    ),
    "deny",
    "config deny rule before allow rule → deny wins",
  );
}

// ── Section 6: persistence ────────────────────────────────────────────────────
console.log("\n6. persistence (read/write/compile)");

{
  const tmpDir = mkdtempSync(join(tmpdir(), "poo-pi-permissions-"));
  const piDir = join(tmpDir, ".pi");
  mkdirSync(piDir);

  try {
    // Read non-existent → defaults
    const defaults = await readPermissionState(tmpDir);
    assertEqual(defaults.mode, "trusted", "missing config → default mode 'trusted'");
    assertEqual(defaults.rules.length, 0, "missing config → empty rules");

    // Write and read back
    const state = makeState({
      mode: "safe",
      rules: [{ tool: "bash", action: "deny", pattern: "rm\\s+-rf" }],
      remembered: [{ tool: "write", dirPrefix: "/project/src" }],
    });
    await writePermissionState(tmpDir, state);
    const read = await readPermissionState(tmpDir);

    assertEqual(read.mode, "safe", "persisted mode round-trips");
    assertEqual(read.rules.length, 1, "persisted rule round-trips");
    assertEqual(read.rules[0].action, "deny", "persisted rule action");
    assertEqual(read.rules[0].pattern, "rm\\s+-rf", "persisted rule pattern");
    assert(read.rules[0].regex instanceof RegExp, "persisted rule has compiled regex");
    assertEqual(read.remembered.length, 1, "persisted grant round-trips");
    assertEqual(read.remembered[0].dirPrefix, "/project/src", "persisted grant dirPrefix");

    // Malformed JSON → defaults
    writeFileSync(join(piDir, "core-permissions.json"), "{ bad json");
    const fallback = await readPermissionState(tmpDir);
    assertEqual(fallback.mode, "trusted", "malformed JSON → default mode");

    // Invalid regex in rule → dropped with warning
    const withBadRegex = parseAndCompile({
      mode: "trusted",
      rules: [
        { tool: "bash", action: "deny", pattern: "valid_pattern" },
        { tool: "bash", action: "deny", pattern: "[invalid" },
      ],
    });
    assertEqual(withBadRegex.rules.length, 1, "invalid regex rule is dropped");

    // validateConfig: valid
    const valid = validateConfig({ mode: "safe", rules: [], remembered: [] });
    assert(typeof valid === "object", "validateConfig: valid config returns state");

    // validateConfig: invalid mode
    const invalidMode = validateConfig({ mode: "godmode", rules: [] });
    assert(typeof invalidMode === "string", "validateConfig: invalid mode returns error string");

    // validateConfig: invalid JSON shape
    const invalidShape = validateConfig("not an object");
    assert(typeof invalidShape === "string", "validateConfig: non-object returns error string");
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

// ── Section 7: headless enforcement ──────────────────────────────────────────
console.log("\n7. headless enforcement (handler + !hasUI path)");

{
  const state = makeState({ mode: "safe" }); // safe blocks write, but headless → open
  const mutex = createMutex();
  const notifiedRef = [false];
  const handler = buildToolCallHandler(state, mutex, notifiedRef);

  const makeCtx = (hasUI, cwd = CWD) => ({
    hasUI,
    cwd,
    signal: undefined,
    ui: {
      select: async () => {
        throw new Error("select should not be called headless");
      },
      input: async () => {
        throw new Error("input should not be called headless");
      },
      notify: () => {},
    },
  });

  // Headless write → allowed (open mode, no blocking)
  const writeEvent = {
    type: "tool_call",
    toolName: "write",
    input: { path: `${CWD}/src/newfile.ts`, content: "..." },
  };
  const headlessWriteResult = await handler(writeEvent, makeCtx(false));
  assert(
    headlessWriteResult === undefined || headlessWriteResult?.block !== true,
    "headless: write allowed (open mode, hasUI=false)",
  );

  // Headless .env read → denied even in open mode
  const envReadEvent = {
    type: "tool_call",
    toolName: "read",
    input: { path: `${CWD}/.env` },
  };
  const headlessEnvResult = await handler(envReadEvent, makeCtx(false));
  assert(headlessEnvResult?.block === true, "headless: .env read denied despite open mode");
}

// ── Section 8: bash Always grant editor fallback ─────────────────────────────
console.log("\n8. bash Always grant editor fallback");

{
  const tmpDir = mkdtempSync(join(tmpdir(), "poo-pi-permissions-"));

  try {
    const state = makeState({ mode: "safe" });
    let editorPrefill;
    const ctx = {
      hasUI: true,
      cwd: tmpDir,
      signal: undefined,
      ui: {
        select: async () => "Always For This Project",
        editor: async (_title, prefill) => {
          editorPrefill = prefill;
          return "";
        },
        input: async () => {
          throw new Error("input should not be used for bash rule refinement");
        },
        notify: () => {},
      },
    };

    await askOperator(
      ctx,
      state,
      "bash",
      bashTarget("rg permissions extensions/core/extensions/permissions"),
    );

    assertEqual(editorPrefill, "^rg\\b", "bash Always: editor opens with derived regex prefill");
    assertEqual(
      state.remembered[0]?.pattern,
      "^rg\\b",
      "bash Always: blank editor submit falls back to derived regex",
    );
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
}

// ── Section 9: concurrency (mutex) ────────────────────────────────────────────
console.log("\n9. concurrency — mutex serializes concurrent ask dialogs");

{
  const state = makeState({ mode: "safe" }); // write → ask in safe
  const mutex = createMutex();
  const notifiedRef = [false];
  const handler = buildToolCallHandler(state, mutex, notifiedRef);

  const dialogOrder = [];
  let resolveFirst;

  const makeAskCtx = (id) => ({
    hasUI: true,
    cwd: CWD,
    signal: undefined,
    ui: {
      select: async () => {
        dialogOrder.push(`open:${id}`);
        if (id === 1) {
          await new Promise((r) => {
            resolveFirst = r;
          });
        }
        dialogOrder.push(`close:${id}`);
        return "Deny";
      },
      input: async () => "",
      notify: () => {},
    },
  });

  const writeEvent = (filename) => ({
    type: "tool_call",
    toolName: "write",
    input: { path: `${CWD}/${filename}` },
  });

  // Start both concurrently
  const p1 = handler(writeEvent("a.ts"), makeAskCtx(1));
  const p2 = handler(writeEvent("b.ts"), makeAskCtx(2));

  // Let event loop advance so both are queued in the mutex
  await new Promise((r) => setTimeout(r, 10));

  // Unblock dialog 1
  if (resolveFirst) resolveFirst();

  await Promise.all([p1, p2]);

  // Verify: dialog 1 must close before dialog 2 opens
  const idx = (label) => dialogOrder.indexOf(label);
  assert(
    idx("close:1") < idx("open:2"),
    `mutex: dialog 1 closes before dialog 2 opens (order: ${dialogOrder.join(", ")})`,
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nsmoke:permissions — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
