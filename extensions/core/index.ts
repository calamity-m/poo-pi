import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { registerClear } from "./extensions/clear.ts";
import { registerCompactionMetadata } from "./extensions/compaction-metadata.ts";
import { registerContext } from "./extensions/context.ts";
import { registerCoreFooter } from "./extensions/footer.ts";
import { registerCoreHeader } from "./extensions/header.ts";
import { registerGatedT1 } from "./extensions/gated-t1.ts";
import { registerHelp } from "./extensions/help.ts";
import { registerHistorySearch } from "./extensions/history-search.ts";
import { registerInterview } from "./extensions/interview/index.ts";
import { registerLumen } from "./extensions/lumen.ts";
import { registerPermissions } from "./extensions/permissions/index.ts";
import { registerPrompt } from "./extensions/prompt.ts";
import { registerProxy } from "./extensions/proxy/index.ts";
import { registerCoreSettings } from "./extensions/settings.ts";
import { registerSkills } from "./extensions/skills/index.ts";
import { registerSubagents } from "./extensions/subagents/index.ts";
import { registerThemeSwitcher } from "./extensions/theme-switcher.ts";
import {
  registerAddGitWorktree,
  registerWorktree,
  registerWorktreeContext,
} from "./extensions/worktree/index.ts";

/**
 * Loads the core extension bundle without enabling any core capabilities yet.
 */
export default function core(pi: ExtensionAPI) {
  registerClear(pi);
  registerCompactionMetadata(pi);
  registerContext(pi);
  registerCoreHeader(pi);
  registerGatedT1(pi);
  registerHelp(pi);
  registerHistorySearch(pi);
  registerInterview(pi);
  registerLumen(pi);
  registerPrompt(pi);
  registerSkills(pi);
  registerThemeSwitcher(pi);
  const proxy = registerProxy(pi);
  const subagents = registerSubagents(pi, { proxy });
  registerWorktree(pi);
  registerWorktreeContext(pi);
  registerAddGitWorktree(pi);
  const permissions = registerPermissions(pi);
  const footer = registerCoreFooter(pi, { permissions, proxy, subagents });
  registerCoreSettings(pi, { permissions, footer });
}
