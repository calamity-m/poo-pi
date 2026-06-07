import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");
const scriptsDir = join(repoRoot, "scripts");
const generatedCa = join(repoRoot, "test-fixtures", "tls", "generated", "ca.crt");

const smokeScripts = [
  { name: "smoke-tls-fixture", script: "smoke-tls-fixture.mjs", timeoutMs: 10_000 },
  { name: "smoke-tls-consumers", script: "smoke-tls-consumers.mjs", timeoutMs: 10_000 },
  {
    name: "smoke-proxy-mtls",
    script: "smoke-proxy-mtls.mjs",
    timeoutMs: 60_000,
    env: { NODE_EXTRA_CA_CERTS: generatedCa },
  },
  { name: "smoke-proxy-audit", script: "smoke-proxy-audit.mjs", timeoutMs: 30_000 },
  { name: "smoke-proxy-reload", script: "smoke-proxy-reload.mjs", timeoutMs: 10_000 },
  { name: "smoke-permissions", script: "smoke-permissions.mjs", timeoutMs: 60_000 },
];

/**
 * Run the existing smoke scripts as Node test-runner subtests.
 */
test("smoke scripts", async (t) => {
  await assertSmokeScriptInventory();
  await runScript("generate TLS fixtures", "generate-tls-fixtures.mjs", { timeoutMs: 10_000 });

  for (const smoke of smokeScripts) {
    await t.test(smoke.name, async () => {
      await runScript(smoke.name, smoke.script, smoke);
    });
  }
});

/**
 * Verify every smoke script in scripts/ is represented in this harness.
 *
 * This keeps the hard-coded per-script timeout/env table from silently dropping
 * coverage when a new smoke check is added.
 */
async function assertSmokeScriptInventory() {
  const actual = (await readdir(scriptsDir))
    .filter((file) => file.startsWith("smoke-") && file.endsWith(".mjs"))
    .sort();
  const expected = smokeScripts.map(({ script }) => script).sort();
  assert.deepEqual(
    actual,
    expected,
    "tests/smoke.test.mjs must cover every scripts/smoke-*.mjs file",
  );
}

/**
 * Execute one scripts/*.mjs file and fail with captured diagnostics on errors.
 *
 * @param {string} name Human-readable command name used in failure messages.
 * @param {string} script File name under scripts/ to execute.
 * @param {{ env?: Record<string, string>, timeoutMs?: number }} options Child process options.
 */
async function runScript(name, script, { env = {}, timeoutMs = 30_000 } = {}) {
  const scriptPath = join(scriptsDir, script);
  const startedAt = Date.now();
  const command = `${process.execPath} ${scriptPath}`;

  const child = spawn(process.execPath, [scriptPath], {
    cwd: repoRoot,
    env: createChildEnv(env),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const result = await waitForChild(child, timeoutMs);
  const elapsedMs = Date.now() - startedAt;
  if (result.ok) return;

  throw new Error(
    [
      `${name} failed`,
      `command: ${command}`,
      `exitCode: ${result.exitCode ?? ""}`,
      `signal: ${result.signal ?? ""}`,
      `elapsedMs: ${elapsedMs}`,
      `timeoutMs: ${timeoutMs}`,
      "stdout:",
      Buffer.concat(stdout).toString("utf8").trimEnd(),
      "stderr:",
      Buffer.concat(stderr).toString("utf8").trimEnd(),
    ].join("\n"),
  );
}

/**
 * Build a subprocess environment with proxy/TLS settings cleared by default.
 *
 * @param {Record<string, string>} overrides Scenario-specific environment values.
 * @returns {NodeJS.ProcessEnv} Environment for a smoke subprocess.
 */
function createChildEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of [
    "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
  ]) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

/**
 * Wait for a child process, killing it if the timeout expires.
 *
 * @param {import("node:child_process").ChildProcess} child Process to observe.
 * @param {number} timeoutMs Milliseconds before the process is killed.
 * @returns {Promise<{ ok: true } | { ok: false, exitCode: number | null, signal: NodeJS.Signals | null }>}
 */
function waitForChild(child, timeoutMs) {
  return new Promise((resolvePromise) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.on("error", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise({ ok: false, exitCode: null, signal: null });
    });

    child.on("close", (exitCode, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolvePromise(exitCode === 0 ? { ok: true } : { ok: false, exitCode, signal });
    });
  });
}
