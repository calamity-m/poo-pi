#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext } from "node:tls";
import { resolveProxyClientTls } from "../extensions/core/extensions/proxy/index.ts";
import { requireWebsearchClientTls } from "../extensions/core/extensions/websearch.ts";

const unloadedProvider = {
  getClientTls: () => undefined,
  getClientTlsStatus: () => ({ status: "unconfigured", message: "tls: unconfigured" }),
};

// Websearch fails closed without a cert; the proxy attaches opportunistically and never blocks.
if (requireWebsearchClientTls(unloadedProvider).ok)
  throw new Error("websearch did not fail closed before TLS load");
if (resolveProxyClientTls(unloadedProvider) !== undefined)
  throw new Error("proxy should resolve no client TLS before a cert is loaded");

// A throwing provider must also degrade to no client TLS, never propagate.
const throwingProvider = {
  getClientTls: () => {
    throw new Error("provider fault");
  },
  getClientTlsStatus: () => ({ status: "error", message: "tls: error" }),
};
if (resolveProxyClientTls(throwingProvider) !== undefined)
  throw new Error("proxy should swallow TLS provider errors and forward without client TLS");

const pfx = readFileSync(join(process.cwd(), "test-fixtures", "tls", "generated", "client.p12"));
const loadedProvider = {
  getClientTls: () => ({
    sourceId: "pfx-file",
    targetLabel: "client.p12",
    secureContext: createSecureContext({ pfx, passphrase: "poo-pi-test-password" }),
    metadata: {},
  }),
  getClientTlsStatus: () => ({
    status: "loaded",
    sourceId: "pfx-file",
    targetLabel: "client.p12",
    message: "tls: loaded",
  }),
};

const websearchLoaded = requireWebsearchClientTls(loadedProvider);
if (!websearchLoaded.ok || !websearchLoaded.tls.secureContext)
  throw new Error("websearch did not read loaded TLS");

const proxyLoaded = resolveProxyClientTls(loadedProvider);
if (!proxyLoaded?.secureContext) throw new Error("proxy did not read loaded TLS");

console.log("tls consumers ok");
