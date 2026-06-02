#!/usr/bin/env node
// Smoke test for proxy mTLS origination (Deliverable 2).
//
// Exercises extensions/core/extensions/proxy/upstream.ts#requestUpstream against a
// local TLS server that requires a client certificate, reached both directly and
// through a local CONNECT proxy, asserting:
//   - the client cert is presented (the gateway sees the client CN) when loaded;
//   - the request still completes without a client cert (graceful forward);
//   - the response streams chunk-by-chunk (no buffering) over the proxy + mTLS path.
//
// Server trust is provided via NODE_EXTRA_CA_CERTS (set by the npm script), so the
// no-cert path is not entangled with server-certificate verification. Run with:
//   npm run smoke:proxy-mtls   (after npm run fixtures:tls)

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect as netConnect } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createSecureContext } from "node:tls";

import { requestUpstream } from "../extensions/core/extensions/proxy/upstream.ts";

const generated = join(process.cwd(), "test-fixtures", "tls", "generated");
const caCrt = join(generated, "ca.crt");
const caKey = join(generated, "ca.key");
const clientPfx = join(generated, "client.p12");
const pfxPassword = "poo-pi-test-password";

for (const file of [caCrt, caKey, clientPfx]) {
  if (!existsSync(file)) {
    console.error(`missing TLS fixture ${file}; run \`npm run fixtures:tls\` first`);
    process.exit(1);
  }
}

const tmp = mkdtempSync(join(tmpdir(), "poo-pi-proxy-mtls-"));
const cleanups = [];
const cleanup = () => {
  for (const fn of cleanups.reverse()) {
    try {
      fn();
    } catch {
      // best-effort teardown
    }
  }
  rmSync(tmp, { recursive: true, force: true });
};

try {
  const { serverKey, serverCert } = generateServerCert(tmp);
  const clientSecureContext = createSecureContext({
    pfx: readFileSync(clientPfx),
    passphrase: pfxPassword,
  });

  // --- Direct, client cert required and presented ---
  const requiring = await startMtlsServer(serverKey, serverCert, { rejectUnauthorized: true });
  cleanups.push(() => requiring.close());
  clearProxyEnv();
  const direct = await fetchUpstream(`https://127.0.0.1:${requiring.port}/v1/messages`, {
    secureContext: clientSecureContext,
  });
  assert(direct.status === 200, `direct status ${direct.status}`);
  assert(
    direct.clientCn.includes("poo-pi-test-client"),
    `direct gateway saw client CN "${direct.clientCn}"`,
  );

  // --- Direct, no client cert: graceful forward still completes ---
  const optional = await startMtlsServer(serverKey, serverCert, { rejectUnauthorized: false });
  cleanups.push(() => optional.close());
  const noCert = await fetchUpstream(`https://127.0.0.1:${optional.port}/v1/messages`, undefined);
  assert(noCert.status === 200, `no-cert status ${noCert.status}`);
  assert(noCert.clientCn === "", `no-cert gateway unexpectedly saw client CN "${noCert.clientCn}"`);

  // --- Through a local CONNECT proxy, client cert presented to the gateway + streaming ---
  const connect = await startConnectProxy();
  cleanups.push(() => connect.close());
  process.env.https_proxy = `http://127.0.0.1:${connect.port}`;
  process.env.HTTPS_PROXY = process.env.https_proxy;
  process.env.no_proxy = "";
  process.env.NO_PROXY = "";
  const tunneled = await fetchUpstream(`https://127.0.0.1:${requiring.port}/v1/messages`, {
    secureContext: clientSecureContext,
  });
  assert(tunneled.status === 200, `tunneled status ${tunneled.status}`);
  assert(connect.connects > 0, "CONNECT proxy did not receive a tunnel request");
  assert(
    tunneled.clientCn.includes("poo-pi-test-client"),
    `tunneled gateway saw client CN "${tunneled.clientCn}" (cert may have leaked to the proxy hop)`,
  );
  assert(tunneled.chunks >= 2, `expected streamed chunks over proxy+mTLS, saw ${tunneled.chunks}`);

  console.log("proxy mtls ok");
} finally {
  cleanup();
}

/** Generate a server key/cert signed by the fixture CA, valid for 127.0.0.1. */
function generateServerCert(dir) {
  const key = join(dir, "server.key");
  const csr = join(dir, "server.csr");
  const cert = join(dir, "server.crt");
  const ext = join(dir, "server.ext");
  writeFileSync(ext, "subjectAltName=IP:127.0.0.1\n");
  run("openssl", ["genrsa", "-out", key, "2048"]);
  run("openssl", ["req", "-new", "-key", key, "-subj", "/CN=127.0.0.1", "-out", csr]);
  run("openssl", [
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    caCrt,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-extfile",
    ext,
    "-out",
    cert,
    "-days",
    "5",
    "-sha256",
  ]);
  return { serverKey: readFileSync(key), serverCert: readFileSync(cert) };
}

/** Start a TLS server that requests a client cert and streams an SSE-style response. */
function startMtlsServer(key, cert, { rejectUnauthorized }) {
  return new Promise((resolve) => {
    const server = createHttpsServer(
      { key, cert, ca: readFileSync(caCrt), requestCert: true, rejectUnauthorized },
      (req, res) => {
        const peer = req.socket.getPeerCertificate();
        const clientCn = peer && peer.subject ? (peer.subject.CN ?? "") : "";
        res.writeHead(200, { "content-type": "text/event-stream", "x-client-cn": clientCn });
        res.write("data: one\n\n");
        // Delay the second chunk so a buffering client would coalesce them.
        setTimeout(() => {
          res.write("data: two\n\n");
          res.end();
        }, 25);
      },
    );
    server.listen(0, "127.0.0.1", () =>
      resolve({ port: server.address().port, close: () => server.close() }),
    );
  });
}

/** Start a minimal HTTP CONNECT proxy and count tunnels it establishes. */
function startConnectProxy() {
  let connects = 0;
  return new Promise((resolve) => {
    const server = createHttpServer();
    server.on("connect", (req, clientSocket, head) => {
      connects += 1;
      const [host, port] = req.url.split(":");
      const upstream = netConnect(Number(port), host, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head && head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({
        port: server.address().port,
        close: () => server.close(),
        get connects() {
          return connects;
        },
      }),
    );
  });
}

/** Forward a request through requestUpstream and collect status, gateway-seen client CN, and chunk count. */
async function fetchUpstream(url, tlsOptions) {
  const res = await requestUpstream({ url, method: "GET", headers: {} }, tlsOptions);
  let chunks = 0;
  await new Promise((resolve, reject) => {
    res.on("data", () => {
      chunks += 1;
    });
    res.on("end", resolve);
    res.on("error", reject);
  });
  return { status: res.statusCode, clientCn: res.headers["x-client-cn"] ?? "", chunks };
}

/** Remove host-proxy env so direct tests connect directly. */
function clearProxyEnv() {
  for (const name of ["http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"])
    delete process.env[name];
}

/** Run a command, failing the smoke test on non-zero exit. */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`${command} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}

/** Throw when a smoke assertion fails. */
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
