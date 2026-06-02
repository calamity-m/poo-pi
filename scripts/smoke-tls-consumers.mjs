#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSecureContext } from 'node:tls';
import { requireProxyClientTls } from '../extensions/core/extensions/proxy/index.ts';
import { requireWebsearchClientTls } from '../extensions/core/extensions/websearch.ts';

const unloadedProvider = {
  getClientTls: () => undefined,
  getClientTlsStatus: () => ({ status: 'unconfigured', message: 'tls: unconfigured' }),
};

for (const resolve of [requireProxyClientTls, requireWebsearchClientTls]) {
  const result = resolve(unloadedProvider);
  if (result.ok) throw new Error('consumer did not fail closed before TLS load');
}

const pfx = readFileSync(join(process.cwd(), 'test-fixtures', 'tls', 'generated', 'client.p12'));
const loadedProvider = {
  getClientTls: () => ({
    sourceId: 'pfx-file',
    targetLabel: 'client.p12',
    secureContext: createSecureContext({ pfx, passphrase: 'poo-pi-test-password' }),
    metadata: {},
  }),
  getClientTlsStatus: () => ({ status: 'loaded', sourceId: 'pfx-file', targetLabel: 'client.p12', message: 'tls: loaded' }),
};

for (const resolve of [requireProxyClientTls, requireWebsearchClientTls]) {
  const result = resolve(loadedProvider);
  if (!result.ok || !result.tls.secureContext) throw new Error('consumer did not read loaded TLS');
}
console.log('tls consumers ok');
