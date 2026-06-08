import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerClear } from "./extensions/clear.ts";
import { registerContext } from "./extensions/context.ts";
import { registerCoreFooter } from "./extensions/footer.ts";
import { registerHistorySearch } from "./extensions/history-search.ts";
import { registerModels } from "./extensions/models.ts";
import { registerPermissions } from "./extensions/permissions/index.ts";
import { registerPrompt } from "./extensions/prompt.ts";
import { registerProxy } from "./extensions/proxy/index.ts";
import { registerCoreSettings } from "./extensions/settings.ts";
import { registerSkills } from "./extensions/skills/index.ts";
import { registerSubagents } from "./extensions/subagents/index.ts";
import { registerTls } from "./extensions/tls/index.ts";

/**
 * Loads the core extension bundle without enabling any core capabilities yet.
 */
export default function core(pi: ExtensionAPI) {
  const tls = registerTls(pi);
  registerClear(pi);
  registerContext(pi);
  registerHistorySearch(pi);
  registerModels(pi);
  registerPrompt(pi);
  registerSkills(pi);
  // TLS resolves during session_start; the proxy reads it lazily per request and attaches the
  // client cert when loaded, forwarding without it otherwise (never blocks traffic).
  const proxy = registerProxy(pi, { tlsProvider: tls });
  const subagents = registerSubagents(pi, { proxy });
  const permissions = registerPermissions(pi);
  registerCoreSettings(pi, { permissions, tls });
  registerCoreFooter(pi, { permissions, tls, proxy, subagents });
}
