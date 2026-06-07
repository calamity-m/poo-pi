#!/usr/bin/env node
// Smoke test for the proxy server + audit pipeline (Deliverables 1 & 3).
//
// Starts the loopback proxy against a local echo upstream, sends a request through
// a `/p/<routeId>` route, and asserts:
//   - the request is forwarded and the response streams back;
//   - a per-request audit JSON and an index.jsonl line are written, capturing the
//     body, parsed model, and response status;
//   - the redaction switch defaults to masking sensitive headers, and flipping it
//     off logs them raw.

import { createServer } from "node:http";
import { request as httpRequest } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createProxyState } from "../extensions/core/extensions/proxy/types.ts";
import { startProxyServer, stopProxyServer } from "../extensions/core/extensions/proxy/server.ts";
import {
  auditPaths,
  readRecentTail,
  writeRedactionMode,
} from "../extensions/core/extensions/proxy/audit.ts";
import { readCoreProxyRedactionMode } from "../extensions/core/config/persistence.ts";

const unloadedTls = {
  getClientTls: () => undefined,
  getClientTlsStatus: () => ({ status: "unconfigured", message: "tls: unconfigured" }),
};

const cwd = mkdtempSync(join(tmpdir(), "poo-pi-proxy-audit-"));
const cleanups = [];

try {
  const upstream = await startEchoServer();
  cleanups.push(() => upstream.close());

  const state = createProxyState();
  await startProxyServer(state, unloadedTls, cwd);
  cleanups.push(() => stopProxyServer(state));
  assert(state.port !== undefined, "proxy server did not bind a port");
  state.routes.set("echo", {
    provider: "echo",
    routeId: "echo",
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}`,
  });

  // Default redaction (on): authorization header is masked in the audit record.
  const first = await proxyRequest(
    state.port,
    { authorization: "secret-key" },
    { model: "m1", q: 1 },
  );
  assert(first.status === 200, `forwarded status ${first.status}`);
  assert(first.body.includes("echo:"), "response was not forwarded from the upstream");

  const recordOn = await waitForRecord(state, 1);
  assert(existsSync(join(cwd, ".pi", "proxy-audit", "requests")), "audit requests dir missing");
  assert(
    readdirSync(join(cwd, ".pi", "proxy-audit", "requests")).some((f) => f.endsWith(".json")),
    "no audit file written",
  );
  assert(recordOn.model === "m1", `model not parsed (${recordOn.model})`);
  assert(recordOn.response.status === 200, `audit status ${recordOn.response.status}`);
  assert(recordOn.request.body?.includes('"q":1'), "audit body not captured");
  assert(
    recordOn.request.headers.authorization === "[redacted]",
    "authorization not redacted by default",
  );

  // Flip redaction off: the next request logs the header raw.
  await writeRedactionMode(state.auditDir, "off");
  await proxyRequest(state.port, { authorization: "secret-key" }, { model: "m2" });
  const recordOff = await waitForRecord(state, 2);
  assert(
    recordOff.request.headers.authorization === "secret-key",
    "authorization not logged raw when redaction off",
  );

  // Large bodies keep both edges in the per-request file while the index stays compact.
  await proxyRequest(state.port, {}, { model: "m3", prompt: `BEGIN${"x".repeat(140 * 1024)}END` });
  const recordLarge = await waitForRecord(state, 3);
  assert(recordLarge.request.bodyTruncated === true, "large index record not marked truncated");
  assert(recordLarge.request.bodyBytes > 128 * 1024, "large index record missing byte count");
  assert(recordLarge.request.bodyHead === undefined, "large index record should omit body head");
  const largeFile = readdirSync(join(cwd, ".pi", "proxy-audit", "requests")).find((f) =>
    f.includes("m3"),
  );
  assert(largeFile, "large audit file missing");
  const largeRecord = JSON.parse(
    readFileSync(join(cwd, ".pi", "proxy-audit", "requests", largeFile), "utf8"),
  );
  assert(largeRecord.request.bodyHead.includes("BEGIN"), "large audit body head missing");
  assert(largeRecord.request.bodyTail.includes("END"), "large audit body tail missing");
  assert(largeRecord.request.body === undefined, "large audit file should not store a prefix body");

  // The /core-settings UI flips redaction through a cwd-derived audit dir (no proxy
  // state needed), persisting to core-settings.json and reading back the same way.
  const cwdAuditDir = auditPaths(cwd).dir;
  await writeRedactionMode(cwdAuditDir, "on");
  assert(
    (await readCoreProxyRedactionMode(cwdAuditDir)) === "on",
    "cwd-derived redaction write did not round-trip",
  );

  console.log("proxy audit ok");
} finally {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {
      // best-effort teardown
    }
  }
  rmSync(cwd, { recursive: true, force: true });
}

/** Start a tiny HTTP upstream that streams an echo of the request path. */
function startEchoServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write(`echo: ${req.url}\n`);
      res.end("done\n");
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, close: () => server.close() }),
    );
  });
}

/** Send a POST through the proxy and collect its status and body. */
function proxyRequest(port, headers, bodyObject) {
  const body = JSON.stringify(bodyObject);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `http://127.0.0.1:${port}/p/echo/v1/messages`,
      { method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Poll the audit index until at least `count` records are present, then return the last one. */
async function waitForRecord(state, count) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const records = await readRecentTail(state.auditDir, 10);
    if (records.length >= count) return records[records.length - 1];
    await delay(20);
  }
  throw new Error(`audit record ${count} was not written in time`);
}

/** Resolve after the given milliseconds. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Throw when a smoke assertion fails. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
