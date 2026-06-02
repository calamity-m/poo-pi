import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerModels } from "./extensions/models.ts";
import { registerPermissions } from "./extensions/permissions/index.ts";
import { registerProxy } from "./extensions/proxy/index.ts";
import { registerSubagents } from "./extensions/subagents.ts";
import { registerTls } from "./extensions/tls/index.ts";
import { registerWebsearch } from "./extensions/websearch.ts";

/**
 * Loads the core extension bundle without enabling any core capabilities yet.
 */
export default function core(pi: ExtensionAPI) {
  const tlsProvider = registerTls(pi);
  registerModels(pi);
  registerSubagents(pi);
  // TLS resolves during session_start; consumers read lazily at request-time and fail closed before it is loaded.
  registerProxy(pi, { tlsProvider });
  registerPermissions(pi);
  registerWebsearch(pi, { tlsProvider });
}
