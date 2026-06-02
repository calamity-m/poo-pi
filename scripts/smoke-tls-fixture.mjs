#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createSecureContext } from "node:tls";

const pfxPath = join(process.cwd(), "test-fixtures", "tls", "generated", "client.p12");
const pfx = readFileSync(pfxPath);
createSecureContext({ pfx, passphrase: "poo-pi-test-password" });
try {
  createSecureContext({ pfx, passphrase: "wrong-password" });
  throw new Error("wrong PFX password unexpectedly loaded");
} catch (error) {
  if (error.message === "wrong PFX password unexpectedly loaded") throw error;
}
console.log("tls fixture ok");
