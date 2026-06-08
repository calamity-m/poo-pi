import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { resolveLinkedWorktree, type LinkedWorktreeInfo } from "../../lib/worktree.ts";

/** Register per-turn linked-worktree context injection for the agent prompt. */
export function registerWorktreeContext(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    injectWorktreeSystemPrompt(event, ctx);
  });
}

/** Append a concise linked-worktree note when the effective Pi cwd is in a linked worktree. */
function injectWorktreeSystemPrompt(event: BeforeAgentStartEvent, ctx: ExtensionContext): void {
  const cwd = event.systemPromptOptions.cwd || ctx.cwd;
  if (!cwd) return;
  const info = resolveLinkedWorktree(cwd, { refresh: true });
  if (!info) return;
  event.systemPromptOptions.appendSystemPrompt = appendSystemPromptNote(
    event.systemPromptOptions.appendSystemPrompt,
    formatWorktreePromptNote(info),
  );
}

/** Add a note to existing appendSystemPrompt text with exactly one blank separator. */
function appendSystemPromptNote(existing: string | undefined, note: string): string {
  return existing && existing.trim().length > 0 ? `${existing.trimEnd()}\n\n${note}` : note;
}

/** Format the agent-facing linked-worktree context note. */
function formatWorktreePromptNote(info: LinkedWorktreeInfo): string {
  return [
    "Worktree context:",
    `- Linked worktree: ${info.label}`,
    `- Branch: ${info.branch}`,
    `- Worktree root: ${info.root}`,
    `- Current Pi working directory: ${info.cwd}`,
  ].join("\n");
}

/** Expose pure helpers for focused unit tests. */
export const __worktreeContextForTest = {
  appendSystemPromptNote,
  formatWorktreePromptNote,
} satisfies Record<string, unknown>;
