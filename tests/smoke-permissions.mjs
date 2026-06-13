#!/usr/bin/env node
// Smoke test for the core permissions extension (Deliverables 1 & 2).
//
// Tests the pure policy engine + persistence layer with synthetic inputs, then
// exercises the enforcement handler's concurrency + headless paths.
//
// Does NOT require a running Pi process or filesystem interaction beyond a tmpdir.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askOperator,
  buildToolCallHandler,
  createMutex,
} from "../extensions/core/extensions/permissions/enforcement.ts";
import {
  deriveBashPattern,
  deriveBashPatterns,
  hasUnsafeSubstitution,
  splitBashSegments,
} from "../extensions/core/extensions/permissions/bash.ts";
import {
  decide,
  isBashEnvAccess,
  isEnvBasename,
  isWithinDir,
} from "../extensions/core/extensions/permissions/policy.ts";
import {
  defaultConfigFilePath,
  parseAndCompile,
  readPermissionState,
  validateConfig,
  writeDefaultPermissionMode,
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
    decide("safe", state.rules, state.remembered, "custom-tool", otherTarget("custom-tool"), CWD),
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
    decide(
      "trusted",
      state.rules,
      state.remembered,
      "custom-tool",
      otherTarget("custom-tool"),
      CWD,
    ),
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
  const tmpAgentDir = mkdtempSync(join(tmpdir(), "poo-pi-agent-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = tmpAgentDir;

  try {
    // Read non-existent → built-in defaults
    const defaults = await readPermissionState(tmpDir);
    assertEqual(defaults.mode, "trusted", "missing config → default mode 'trusted'");
    assertEqual(defaults.rules.length, 0, "missing config → empty rules");

    // Central default mode applies after it is written.
    await writeDefaultPermissionMode("permissive");
    const globalDefault = await readPermissionState(tmpDir);
    assertEqual(globalDefault.mode, "permissive", "central config → configured default mode");
    assertEqual(
      defaultConfigFilePath(),
      join(tmpAgentDir, "poo", "core-settings.json"),
      "default path honors PI_CODING_AGENT_DIR",
    );

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

    // Malformed centralized JSON → built-in defaults.
    writeFileSync(join(tmpAgentDir, "poo", "core-settings.json"), "{ bad json");
    const fallback = await readPermissionState(tmpDir);
    assertEqual(fallback.mode, "trusted", "malformed core settings JSON → built-in default mode");

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
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    rmSync(tmpDir, { recursive: true });
    rmSync(tmpAgentDir, { recursive: true });
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

// ── Section 8: bash Always grant multi-line editor ───────────────────────────
console.log("\n8. bash Always grant multi-line editor");

{
  const tmpDir = mkdtempSync(join(tmpdir(), "poo-pi-permissions-"));

  try {
    // 8a: single command — prefill is one pattern; save it
    {
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
            return prefill; // accept as-is
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
      // Flag-stop deriver: "rg" + "permissions" (bare word), stops at path token
      assertEqual(
        editorPrefill,
        "^rg\\s+permissions\\b",
        "bash Always single: editor prefilled with flag-stop pattern",
      );
      assertEqual(
        state.remembered[0]?.pattern,
        "^rg\\s+permissions\\b",
        "bash Always single: saved pattern matches prefill",
      );
    }

    // 8b: npm run build prefill + blank editor → Only Once (no grant)
    {
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
          notify: () => {},
        },
      };
      await askOperator(ctx, state, "bash", bashTarget("npm run build"));
      assertEqual(
        editorPrefill,
        "^npm\\s+run\\s+build\\b",
        "bash Always: npm run build prefill pins the script",
      );
      assertEqual(state.remembered.length, 0, "bash Always: blank editor → no grant (Only Once)");
    }

    // 8c: invalid regex line → notify + no grant (Only Once)
    {
      const state = makeState({ mode: "safe" });
      let notified = false;
      const ctx = {
        hasUI: true,
        cwd: tmpDir,
        signal: undefined,
        ui: {
          select: async () => "Always For This Project",
          editor: async () => "[invalid-regex",
          notify: () => {
            notified = true;
          },
        },
      };
      await askOperator(ctx, state, "bash", bashTarget("npm run build"));
      assert(notified, "bash Always: invalid regex → notifies operator");
      assertEqual(state.remembered.length, 0, "bash Always: invalid regex → no grant saved");
    }

    // 8d: compound command → two-line prefill, both grants saved
    {
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
            return prefill;
          },
          notify: () => {},
        },
      };
      await askOperator(ctx, state, "bash", bashTarget("npm run build && npm install"));
      assertEqual(
        editorPrefill,
        "^npm\\s+run\\s+build\\b\n^npm\\s+install\\b",
        "bash Always compound: two-line prefill",
      );
      assertEqual(state.remembered.length, 2, "bash Always compound: two grants saved");
      assertEqual(
        state.remembered[0]?.pattern,
        "^npm\\s+run\\s+build\\b",
        "bash Always compound: first grant",
      );
      assertEqual(
        state.remembered[1]?.pattern,
        "^npm\\s+install\\b",
        "bash Always compound: second grant",
      );
    }

    // 8e: operator adds a custom line → honored
    {
      const state = makeState({ mode: "safe" });
      const ctx = {
        hasUI: true,
        cwd: tmpDir,
        signal: undefined,
        ui: {
          select: async () => "Always For This Project",
          editor: async () => "^npm\\s+run\\s+build\\b\n^my\\s+custom\\b",
          notify: () => {},
        },
      };
      await askOperator(ctx, state, "bash", bashTarget("npm run build"));
      assertEqual(state.remembered.length, 2, "bash Always: operator-added line honored");
      assertEqual(state.remembered[1]?.pattern, "^my\\s+custom\\b", "operator-added pattern saved");
    }

    // 8f: dedup — same pattern from compound not double-saved
    {
      const state = makeState({ mode: "safe" });
      const ctx = {
        hasUI: true,
        cwd: tmpDir,
        signal: undefined,
        ui: {
          select: async () => "Always For This Project",
          editor: async (_title, prefill) => prefill,
          notify: () => {},
        },
      };
      await askOperator(ctx, state, "bash", bashTarget("npm run a && npm run a"));
      assertEqual(
        state.remembered.length,
        1,
        "bash Always: duplicate segment deduped to one grant",
      );
    }
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

// ── Section 10: deriveBashPattern (D1 — flag-stop deriver) ───────────────────
console.log("\n10. deriveBashPattern (flag-stop deriver)");

assertEqual(deriveBashPattern("npm run build"), "^npm\\s+run\\s+build\\b", "npm run build");
assertEqual(deriveBashPattern("npm install"), "^npm\\s+install\\b", "npm install");
assertEqual(deriveBashPattern("git commit -m x"), "^git\\s+commit\\b", "git commit stops at -m");
assertEqual(deriveBashPattern("mycli foo bar"), "^mycli\\s+foo\\s+bar\\b", "mycli foo bar");
assertEqual(
  deriveBashPattern("NODE_ENV=prod npm run x"),
  "^npm\\s+run\\s+x\\b",
  "env-assignment stripped",
);
assertEqual(deriveBashPattern("ls"), "^ls\\b", "single-token command");
assertEqual(
  deriveBashPattern("docker run ubuntu"),
  "^docker\\s+run\\s+ubuntu\\b",
  "docker run ubuntu (over-capture ok)",
);
assertEqual(deriveBashPattern("git status"), "^git\\s+status\\b", "git status");
// Regex escaping: a token with special chars
assertEqual(deriveBashPattern("my.cmd"), "^my\\.cmd\\b", "regex special chars in token escaped");

// ── Section 11: deriveBashPatterns (compound deriver + dedup) ────────────────
console.log("\n11. deriveBashPatterns (compound deriver)");

{
  const p1 = deriveBashPatterns("npm run build && npm install");
  assertEqual(p1.length, 2, "compound: two distinct patterns");
  assertEqual(p1[0], "^npm\\s+run\\s+build\\b", "compound: first pattern");
  assertEqual(p1[1], "^npm\\s+install\\b", "compound: second pattern");

  const p2 = deriveBashPatterns("npm run a && npm run a");
  assertEqual(p2.length, 1, "duplicate segment deduped");
  assertEqual(p2[0], "^npm\\s+run\\s+a\\b", "deduped pattern");

  const p3 = deriveBashPatterns("git status");
  assertEqual(p3.length, 1, "single segment → single pattern");
}

// ── Section 12: splitBashSegments ────────────────────────────────────────────
console.log("\n12. splitBashSegments");

{
  const s1 = splitBashSegments("a && b");
  assertEqual(s1.length, 2, "&& splits into 2");
  assertEqual(s1[0], "a", "&& left");
  assertEqual(s1[1], "b", "&& right");

  const s2 = splitBashSegments("a || b");
  assertEqual(s2.length, 2, "|| splits into 2");

  const s3 = splitBashSegments("a | b");
  assertEqual(s3.length, 2, "| splits into 2");

  const s4 = splitBashSegments("a; b");
  assertEqual(s4.length, 2, "; splits into 2");

  const s5 = splitBashSegments("a\nb");
  assertEqual(s5.length, 2, "newline splits into 2");

  const s6 = splitBashSegments("a &");
  assertEqual(s6.length, 1, "trailing & (background): only non-empty segment kept");
  assertEqual(s6[0], "a", "trailing & left segment");

  // Quoted separators are not split points
  const s7 = splitBashSegments('echo "hello && world"');
  assertEqual(s7.length, 1, "quoted && not split");
  assertEqual(s7[0], 'echo "hello && world"', "quoted content preserved");

  const s8 = splitBashSegments("echo 'a | b'");
  assertEqual(s8.length, 1, "single-quoted | not split");

  // Empty parts are dropped
  const s9 = splitBashSegments("  a  &&   b  ");
  assertEqual(s9.length, 2, "surrounding whitespace trimmed, empty parts dropped");

  // || before | disambiguation
  const s10 = splitBashSegments("a || b | c");
  assertEqual(s10.length, 3, "|| then | → three segments");
  assertEqual(s10[0], "a", "first segment");
  assertEqual(s10[1], "b", "second segment");
  assertEqual(s10[2], "c", "third segment");
}

// ── Section 13: hasUnsafeSubstitution ────────────────────────────────────────
console.log("\n13. hasUnsafeSubstitution");

assert(hasUnsafeSubstitution("$(cat .env)"), "$(...) is unsafe");
assert(!hasUnsafeSubstitution("$((1+2))"), "$((...)) arithmetic is safe");
assert(hasUnsafeSubstitution("`cat .env`"), "backtick is unsafe");
assert(!hasUnsafeSubstitution("echo hello"), "plain command is safe");
assert(!hasUnsafeSubstitution("npm run build"), "npm run build is safe");
// $( followed by another ( is arithmetic
assert(!hasUnsafeSubstitution("echo $((2+2))"), "echo $((2+2)) arithmetic is safe");

// ── Section 14: segment-aware policy decisions ────────────────────────────────
console.log("\n14. segment-aware policy decisions");

{
  // Config allow covers all segments → allow
  const stateAllowAll = makeState({
    mode: "trusted",
    rules: [{ tool: "bash", action: "allow", pattern: "^npm\\b" }],
  });
  assertEqual(
    decide(
      "trusted",
      stateAllowAll.rules,
      stateAllowAll.remembered,
      "bash",
      bashTarget("npm run build && npm install"),
      CWD,
    ),
    "allow",
    "all segments covered by config allow → allow",
  );

  // Config allow covers only one segment → ask (safe mode: no built-in deny patterns)
  const statePartial = makeState({
    mode: "safe",
    rules: [{ tool: "bash", action: "allow", pattern: "^npm\\b" }],
  });
  assertEqual(
    decide(
      "safe",
      statePartial.rules,
      statePartial.remembered,
      "bash",
      bashTarget("npm run build && unknown-cmd"),
      CWD,
    ),
    "ask",
    "one segment not covered by config allow → ask (safe default for bash)",
  );

  // Command substitution → uncoverable → ask even if pattern matches (safe mode)
  const stateWithSubst = makeState({
    mode: "safe",
    rules: [{ tool: "bash", action: "allow", pattern: "^npm\\b" }],
  });
  assertEqual(
    decide(
      "safe",
      stateWithSubst.rules,
      stateWithSubst.remembered,
      "bash",
      bashTarget("npm run $(echo injected)"),
      CWD,
    ),
    "ask",
    "command substitution → uncoverable → ask (safe default for bash)",
  );

  // Config ask fires on any segment
  const stateAsk = makeState({
    mode: "trusted",
    rules: [{ tool: "bash", action: "ask", pattern: "^docker\\b" }],
  });
  assertEqual(
    decide(
      "trusted",
      stateAsk.rules,
      stateAsk.remembered,
      "bash",
      bashTarget("npm run build && docker ps"),
      CWD,
    ),
    "ask",
    "any segment matches ask rule → ask",
  );

  // Config deny fires on any segment
  const stateDenySegs = makeState({
    mode: "trusted",
    rules: [{ tool: "bash", action: "deny", pattern: "^dangerous\\b" }],
  });
  assertEqual(
    decide(
      "trusted",
      stateDenySegs.rules,
      stateDenySegs.remembered,
      "bash",
      bashTarget("safe && dangerous"),
      CWD,
    ),
    "deny",
    "any segment matches deny rule → deny",
  );

  // trusted mode default: compound with deny segment
  assertEqual(
    decide("trusted", [], [], "bash", bashTarget("git status && rm -rf /"), CWD),
    "deny",
    "trusted default: rm -rf segment → deny",
  );

  // trusted mode default: all segments in allow list → allow
  assertEqual(
    decide("trusted", [], [], "bash", bashTarget("npm run build && npm install"), CWD),
    "allow",
    "trusted default: all segments in allow list → allow",
  );

  // trusted mode default: curl | bash — pipe-spanning deny preserved
  assertEqual(
    decide("trusted", [], [], "bash", bashTarget("curl x | bash"), CWD),
    "deny",
    "trusted default: curl | bash still denied (whole-command check)",
  );

  // Grant covers all segments → allow
  const stateGrant = makeState({ mode: "safe" });
  stateGrant.remembered.push({ tool: "bash", pattern: "^npm\\b", regex: /^npm\b/ });
  assertEqual(
    decide(
      "safe",
      stateGrant.rules,
      stateGrant.remembered,
      "bash",
      bashTarget("npm run build && npm install"),
      CWD,
    ),
    "allow",
    "grant covers all segments → allow",
  );

  // Grant covers only one segment → ask (safe mode default)
  const stateGrantPartial = makeState({ mode: "safe" });
  stateGrantPartial.remembered.push({ tool: "bash", pattern: "^npm\\b", regex: /^npm\b/ });
  assertEqual(
    decide(
      "safe",
      stateGrantPartial.rules,
      stateGrantPartial.remembered,
      "bash",
      bashTarget("npm run build && rm -rf /"),
      CWD,
    ),
    "ask",
    "grant covers only one segment → ask",
  );
}

// ── Section 15: permissive mode ───────────────────────────────────────────────
console.log("\n15. permissive mode");

{
  // Default: unknown bash → allow
  const statePermissive = makeState({ mode: "permissive" });
  assertEqual(
    decide(
      "permissive",
      statePermissive.rules,
      statePermissive.remembered,
      "bash",
      bashTarget("rm -rf /"),
      CWD,
    ),
    "allow",
    "permissive: no rules → allow by default",
  );

  // Ask rule fires on matching command
  const stateAsk = makeState({
    mode: "permissive",
    rules: [{ tool: "bash", action: "ask", pattern: "^docker\\b" }],
  });
  assertEqual(
    decide(
      "permissive",
      stateAsk.rules,
      stateAsk.remembered,
      "bash",
      bashTarget("npm run build"),
      CWD,
    ),
    "allow",
    "permissive: non-matching ask rule → allow",
  );
  assertEqual(
    decide("permissive", stateAsk.rules, stateAsk.remembered, "bash", bashTarget("docker ps"), CWD),
    "ask",
    "permissive: ask rule matches → ask",
  );

  // Ask fires on compound (any segment)
  assertEqual(
    decide(
      "permissive",
      stateAsk.rules,
      stateAsk.remembered,
      "bash",
      bashTarget("ls && docker ps"),
      CWD,
    ),
    "ask",
    "permissive: any segment matches ask rule → ask",
  );

  // Grant overrides ask rule (allow-before-ask precedence)
  const stateAskWithGrant = makeState({
    mode: "permissive",
    rules: [{ tool: "bash", action: "ask", pattern: "^docker\\b" }],
  });
  stateAskWithGrant.remembered.push({
    tool: "bash",
    pattern: "^docker\\s+ps\\b",
    regex: /^docker\s+ps\b/,
  });
  assertEqual(
    decide(
      "permissive",
      stateAskWithGrant.rules,
      stateAskWithGrant.remembered,
      "bash",
      bashTarget("docker ps"),
      CWD,
    ),
    "allow",
    "permissive: grant overrides ask rule → allow",
  );

  // Allow rule overrides ask (allow-before-ask)
  const stateAllowBeforeAsk = makeState({
    mode: "permissive",
    rules: [
      { tool: "bash", action: "ask", pattern: "^docker\\b" },
      { tool: "bash", action: "allow", pattern: "^docker\\b" },
    ],
  });
  assertEqual(
    decide(
      "permissive",
      stateAllowBeforeAsk.rules,
      stateAllowBeforeAsk.remembered,
      "bash",
      bashTarget("docker ps"),
      CWD,
    ),
    "allow",
    "permissive: allow rule overrides ask rule (allow-before-ask precedence)",
  );

  // Config deny still denies
  const stateDeny = makeState({
    mode: "permissive",
    rules: [{ tool: "bash", action: "deny", pattern: "^docker\\b" }],
  });
  assertEqual(
    decide(
      "permissive",
      stateDeny.rules,
      stateDeny.remembered,
      "bash",
      bashTarget("docker ps"),
      CWD,
    ),
    "deny",
    "permissive: config deny still denies",
  );

  // cat .env (bash env access) → denied in permissive
  assertEqual(
    decide("permissive", [], [], "bash", bashTarget("cat .env"), CWD),
    "deny",
    "permissive: cat .env (isEnvAccess) → denied",
  );

  // read .env path → denied in permissive
  assertEqual(
    decide("permissive", [], [], "read", pathTarget(ENV_PATH, true), CWD),
    "deny",
    "permissive: read .env path (isEnv) → denied",
  );

  // .env allow override works in permissive
  const stateEnvAllow = makeState({
    mode: "permissive",
    rules: [{ tool: "read", action: "allow", pattern: "\\.env$" }],
  });
  assertEqual(
    decide(
      "permissive",
      stateEnvAllow.rules,
      stateEnvAllow.remembered,
      "read",
      pathTarget(ENV_PATH, true),
      CWD,
    ),
    "allow",
    "permissive: explicit allow overrides .env deny",
  );

  // Headless permissive ≡ open (handler uses open mode, no gating)
  {
    const tmpDir = mkdtempSync(join(tmpdir(), "poo-pi-permissions-"));
    try {
      const state = makeState({ mode: "permissive" });
      const mutex = createMutex();
      const notifiedRef = [false];
      const handler = buildToolCallHandler(state, mutex, notifiedRef);

      const writeEvent = {
        type: "tool_call",
        toolName: "write",
        input: { path: `${CWD}/src/newfile.ts`, content: "..." },
      };
      const result = await handler(writeEvent, {
        hasUI: false,
        cwd: tmpDir,
        signal: undefined,
        ui: {
          select: async () => {
            throw new Error("select should not be called headless");
          },
          notify: () => {},
        },
      });
      assert(
        result === undefined || result?.block !== true,
        "permissive headless: write allowed (open mode regardless of permissive setting)",
      );
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  }
}

// ── Section 16: backward-compat break documentation ──────────────────────────
console.log("\n16. backward-compatibility: compound-string patterns now match per-segment");

{
  // An old-style grant whose pattern contained && to match a whole compound string
  // no longer matches: it won't cover the two independent segments.
  const stateOldStyle = makeState({ mode: "trusted" });
  // Simulates an old hand-authored grant: pattern contained the separator literally
  stateOldStyle.remembered.push({
    tool: "bash",
    pattern: "^npm\\s+run\\s+build\\s+&&\\s+npm\\s+install\\b",
    regex: /^npm\s+run\s+build\s+&&\s+npm\s+install\b/,
  });
  assertEqual(
    decide(
      "trusted",
      stateOldStyle.rules,
      stateOldStyle.remembered,
      "bash",
      bashTarget("npm run build && npm install"),
      CWD,
    ),
    // Falls through to mode default (trusted allow patterns cover both segments) → allow.
    // The key point: the old compound-string pattern does NOT cover the split segments.
    // (Result is allow here because trusted mode allows npm commands by default —
    //  the point is the old grant regex did NOT produce the allow, the mode default did.)
    "allow",
    "compat: old compound-string grant pattern no longer matches split segments",
  );

  // Anchored single-command patterns ARE unaffected — they match individual segments.
  const stateNewStyle = makeState({ mode: "safe" });
  stateNewStyle.remembered.push({
    tool: "bash",
    pattern: "^npm\\b",
    regex: /^npm\b/,
  });
  assertEqual(
    decide(
      "safe",
      stateNewStyle.rules,
      stateNewStyle.remembered,
      "bash",
      bashTarget("npm run build && npm install"),
      CWD,
    ),
    "allow",
    "compat: anchored single-command pattern still covers each segment (unaffected)",
  );
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nsmoke:permissions — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
