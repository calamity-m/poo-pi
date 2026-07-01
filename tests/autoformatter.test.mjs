import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  loadEffectiveAutoformatterConfig,
  mergeFormatterRules,
  parseAutoformatterSection,
  resolveToolPath,
} from "../extensions/autoformatter/config.ts";
import { runFormatterProcess } from "../extensions/autoformatter/format.ts";
import autoformatterExtension from "../extensions/autoformatter/index.ts";
import {
  globalCoreSettingsPath,
  projectCoreSettingsPath,
} from "../extensions/core/config/paths.ts";

const globalRule = {
  id: "web",
  languages: ["typescript", "javascript"],
  extensions: [".ts", ".js"],
  command: "fmt",
  args: ["{file}"],
  cwd: "project",
  timeoutMs: 1000,
  source: "global",
};
const projectRule = {
  id: "ts-project",
  languages: ["typescript"],
  extensions: [".ts"],
  command: "eslint",
  args: ["--fix", "{file}"],
  cwd: "project",
  timeoutMs: 1000,
  source: "project",
};

/** Run a test with an isolated temp directory. */
async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "poo-pi-autoformatter-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Build a minimal fake Pi object and return its registered tool_result handler. */
function captureToolResultHandler() {
  let handler;
  autoformatterExtension({
    on(event, cb) {
      if (event === "tool_result") handler = cb;
    },
  });
  return handler;
}

test("parseAutoformatterSection keeps valid rules and isolates malformed rules", () => {
  const parsed = parseAutoformatterSection({ formatters: [globalRule, { id: "bad" }] }, "global");
  assert.equal(parsed.rules.length, 1);
  assert.equal(parsed.rules[0].id, "web");
  assert.match(parsed.warnings[0], /command/);
});

test("mergeFormatterRules splits partially overridden multi-language global rules", () => {
  const merged = mergeFormatterRules([globalRule], [projectRule]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].id, "ts-project");
  assert.deepEqual(merged[1].languages, ["javascript"]);
});

test("mergeFormatterRules replaces language-less global rules by id", () => {
  const global = { ...globalRule, id: "plain", languages: undefined };
  const project = { ...projectRule, id: "plain", languages: undefined };
  assert.deepEqual(
    mergeFormatterRules([global], [project]).map((rule) => rule.command),
    ["eslint"],
  );
});

test("loadEffectiveAutoformatterConfig ignores untrusted project config", async () => {
  await withTempDir(async (dir) => {
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    try {
      const projectSettings = projectCoreSettingsPath(dir);
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(dirname(projectSettings), { recursive: true }),
      );
      await writeFile(
        projectSettings,
        JSON.stringify({ version: 1, autoformatter: { formatters: [projectRule] } }),
      );
      const config = await loadEffectiveAutoformatterConfig(
        { cwd: dir, isProjectTrusted: () => false },
        join(dir, "src", "a.ts"),
        new Set(),
      );
      assert.equal(config.rules.length, 0);
      assert.match(config.warnings.join("\n"), /not trusted/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

test("runFormatterProcess handles filenames with spaces and shell metacharacters without a shell", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "formatter.mjs");
    const target = join(dir, "has spaces; echo bad.ts");
    await writeFile(
      script,
      "import { appendFileSync } from 'node:fs'; appendFileSync(process.argv[2], '\\nformatted');\n",
    );
    await chmod(script, 0o700);
    await writeFile(target, "x");
    const result = await runFormatterProcess(
      { ...projectRule, command: process.execPath, args: [script, "{file}"], cwd: "project" },
      target,
      dir,
    );
    assert.equal(result.ok, true);
    assert.equal(await readFile(target, "utf8"), "x\nformatted");
  });
});

test("runFormatterProcess waits for a timed-out formatter to close", async () => {
  await withTempDir(async (dir) => {
    const script = join(dir, "slow-close.mjs");
    const target = join(dir, "a.ts");
    await writeFile(
      script,
      "import { appendFileSync } from 'node:fs'; process.on('SIGTERM', () => setTimeout(() => { appendFileSync(process.argv[2], 'closed'); process.exit(0); }, 100)); setTimeout(() => {}, 5000);\n",
    );
    await writeFile(target, "");
    const started = Date.now();
    const result = await runFormatterProcess(
      { ...projectRule, command: process.execPath, args: [script, "{file}"], timeoutMs: 50 },
      target,
      dir,
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /timed out/);
    assert.ok(Date.now() - started >= 100);
    assert.equal(await readFile(target, "utf8"), "closed");
  });
});

test("tool_result handler suppresses duplicate formatter failure detail", async () => {
  await withTempDir(async (dir) => {
    const handler = captureToolResultHandler();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    try {
      const settingsPath = globalCoreSettingsPath();
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(dirname(settingsPath), { recursive: true }),
      );
      await writeFile(
        settingsPath,
        JSON.stringify({
          version: 1,
          autoformatter: {
            formatters: [
              {
                id: "always-fails",
                extensions: [".ts"],
                command: process.execPath,
                args: ["-e", "console.error('noisy'); process.exit(2)"],
                cwd: "project",
              },
            ],
          },
        }),
      );
      const event = {
        type: "tool_result",
        toolName: "write",
        toolCallId: "1",
        input: { path: "a.ts" },
        content: [],
        details: undefined,
        isError: false,
      };
      const ctx = { cwd: dir, isProjectTrusted: () => true, signal: undefined };
      const firstPatch = await handler(event, ctx);
      const secondPatch = await handler(event, ctx);
      assert.equal(firstPatch.details.autoformatter.stderr, "noisy\n");
      assert.equal(secondPatch.details.autoformatter.stderr, undefined);
      assert.match(secondPatch.content[0].text, /suppressing duplicate detail/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});

test("tool_result handler returns warning-only patch when no rule matches", async () => {
  await withTempDir(async (dir) => {
    const handler = captureToolResultHandler();
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
    try {
      const settingsPath = projectCoreSettingsPath(dir);
      await import("node:fs/promises").then(({ mkdir }) =>
        mkdir(dirname(settingsPath), { recursive: true }),
      );
      await writeFile(
        settingsPath,
        JSON.stringify({ version: 1, autoformatter: { formatters: "bad" } }),
      );
      const patch = await handler(
        {
          type: "tool_result",
          toolName: "write",
          toolCallId: "1",
          input: { path: "a.md" },
          content: [],
          details: undefined,
          isError: false,
        },
        { cwd: dir, isProjectTrusted: () => true, signal: undefined },
      );
      assert.match(patch.content[0].text, /no matching formatter rule/);
      assert.match(patch.content[0].text, /formatters must be an array/);
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  });
});
