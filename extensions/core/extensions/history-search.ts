import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type SessionEntry,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { Container, type Focusable, Input, type KeyId } from "@earendil-works/pi-tui";

import { readCoreHistorySearchSettingsSync } from "../config/persistence.ts";
import { PanelChrome } from "../lib/ui/panel.ts";

/** Maximum number of live matches to show in the picker. */
const MAX_RESULTS = 10;

/** Default shortcut, avoiding Pi's built-in Ctrl+R session-rename binding. */
const DEFAULT_HISTORY_SEARCH_SHORTCUT = "f8";

/** Message role that is useful to paste back into the editor. */
type SearchableRole = "user";

/** One searchable message extracted from a session. */
export interface SearchableMessage {
  /** Session file path, or a synthetic current-session marker when not persisted yet. */
  sessionPath: string;
  /** Human-readable session name, first prompt, or path. */
  sessionTitle: string;
  /** Working directory recorded in the session header, when available. */
  cwd?: string;
  /** Message role shown in the picker. */
  role: SearchableRole;
  /** Plain text that is searched and inserted into the editor when selected. */
  text: string;
  /** Message or entry timestamp in Unix milliseconds. */
  timestamp: number;
}

/** Search result with a UI label and source message. */
export interface HistorySearchResult {
  /** Unique picker label. */
  label: string;
  /** Message represented by the label. */
  message: SearchableMessage;
}

/** Process-local cache for saved-session history so Ctrl+R can open immediately. */
interface SavedHistoryCache {
  /** Last successfully loaded saved-session messages. */
  messages: SearchableMessage[];
  /** Whether at least one full saved-session load has completed. */
  loaded: boolean;
  /** In-flight cache refresh, shared by startup warmup and interactive search. */
  loading?: Promise<SearchableMessage[]>;
}

/** Saved history cache shared by all invocations in this extension runtime. */
const savedHistoryCache: SavedHistoryCache = { messages: [], loaded: false };

/**
 * Read the project-local shortcut at extension load time. The persisted value is
 * an arbitrary user string; Pi validates the exact key syntax at registration, so
 * it is surfaced as a `KeyId` here.
 */
function readHistorySearchShortcut(): KeyId {
  return (readCoreHistorySearchSettingsSync(process.cwd())?.shortcut ??
    DEFAULT_HISTORY_SEARCH_SHORTCUT) as KeyId;
}

/** Register reverse history search via `/history` and the configured shortcut. */
export function registerHistorySearch(pi: ExtensionAPI): void {
  pi.registerCommand("history", {
    description: "Search old user messages and populate the editor with a selection",
    handler: async (args, ctx) => {
      await runHistorySearch(ctx, args.trim());
    },
  });

  pi.registerShortcut(readHistorySearchShortcut(), {
    description: "Search old user messages",
    handler: async (ctx) => {
      await runHistorySearch(ctx, "");
    },
  });

  pi.on("session_start", () => {
    void ensureSavedHistoryCache().catch(() => {
      // Warmup is opportunistic; interactive search can retry later.
    });
  });
}

/** Open live search, then fill the editor with the selected text. */
async function runHistorySearch(
  ctx: ExtensionContext | ExtensionCommandContext,
  initialQuery: string,
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("history search requires an interactive UI", "warning");
    return;
  }

  const currentSessionPath = ctx.sessionManager.getSessionFile();
  const currentMessages = currentSearchableMessages(ctx);
  const initialMessages = mergeSearchableMessages(
    currentMessages,
    savedHistoryCache.messages.filter((message) => message.sessionPath !== currentSessionPath),
  );
  const refresh = ensureSavedHistoryCache();
  let component: HistorySearchComponent | undefined;

  if (!savedHistoryCache.loaded) ctx.ui.setStatus("history-search", "loading old sessions…");
  try {
    const result = await ctx.ui.custom<SearchableMessage | undefined>(
      (tui, theme, keybindings, done) => {
        component = new HistorySearchComponent(
          initialMessages,
          initialQuery,
          theme,
          keybindings,
          done,
          () => tui.requestRender(),
        );
        void refresh
          .then((messages) => {
            component?.setMessages(
              mergeSearchableMessages(
                currentSearchableMessages(ctx),
                messages.filter((message) => message.sessionPath !== currentSessionPath),
              ),
            );
          })
          .catch(() => {
            // Keep the immediately opened current-session search usable if old-session loading fails.
          });
        return component;
      },
    );
    component = undefined;
    if (!result) return;
    ctx.ui.setEditorText(result.text);
  } finally {
    component = undefined;
    ctx.ui.setStatus("history-search", undefined);
  }
}

/** Return current-session messages without touching disk so the picker can open immediately. */
function currentSearchableMessages(
  ctx: ExtensionContext | ExtensionCommandContext,
): SearchableMessage[] {
  const currentSessionPath = ctx.sessionManager.getSessionFile();
  const currentTitle =
    ctx.sessionManager.getSessionName() ?? currentSessionPath ?? "current session";
  return entriesToSearchableMessages(ctx.sessionManager.getEntries(), {
    sessionPath: currentSessionPath ?? "<current-session>",
    sessionTitle: currentTitle,
    cwd: ctx.cwd,
  });
}

/** Start or reuse a saved-session cache refresh. */
function ensureSavedHistoryCache(): Promise<SearchableMessage[]> {
  if (savedHistoryCache.loading) return savedHistoryCache.loading;
  savedHistoryCache.loading = loadSavedHistoryMessages()
    .then((messages) => {
      savedHistoryCache.messages = messages;
      savedHistoryCache.loaded = true;
      return messages;
    })
    .finally(() => {
      savedHistoryCache.loading = undefined;
    });
  return savedHistoryCache.loading;
}

/** Load searchable messages from every known saved Pi session. */
async function loadSavedHistoryMessages(): Promise<SearchableMessage[]> {
  const messages: SearchableMessage[] = [];
  const infos = await SessionManager.listAll();
  for (const info of infos) {
    try {
      const manager = SessionManager.open(info.path);
      messages.push(
        ...entriesToSearchableMessages(manager.getEntries(), {
          sessionPath: info.path,
          sessionTitle: sessionTitle(info),
          cwd: info.cwd,
        }),
      );
    } catch {
      // Skip unreadable or concurrently deleted sessions; search should be best-effort.
    }
  }
  return messages;
}

/** Merge current and cached saved messages, dropping duplicate persisted current-session rows. */
function mergeSearchableMessages(
  currentMessages: readonly SearchableMessage[],
  savedMessages: readonly SearchableMessage[],
): SearchableMessage[] {
  const seen = new Set<string>();
  const merged: SearchableMessage[] = [];
  for (const message of [...currentMessages, ...savedMessages]) {
    const key = `${message.sessionPath}\0${message.timestamp}\0${message.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(message);
  }
  return merged;
}

/** Convert session entries into plain searchable user messages. */
export function entriesToSearchableMessages(
  entries: readonly SessionEntry[],
  session: Pick<SearchableMessage, "sessionPath" | "sessionTitle" | "cwd">,
): SearchableMessage[] {
  const messages: SearchableMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const { message } = entry;
    if (message.role !== "user") continue;

    const text = messageText(message.content).trim();
    if (!text) continue;

    messages.push({
      ...session,
      role: message.role,
      text,
      timestamp:
        typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp),
    });
  }
  return messages;
}

/** Search messages case-insensitively and return most-recent-first picker results. */
export function searchMessages(
  messages: readonly SearchableMessage[],
  query: string,
  limit = MAX_RESULTS,
): HistorySearchResult[] {
  const normalizedQuery = query.toLocaleLowerCase();
  return messages
    .filter((message) => message.text.toLocaleLowerCase().includes(normalizedQuery))
    .sort(
      (a, b) =>
        scoreMessage(b, normalizedQuery) - scoreMessage(a, normalizedQuery) ||
        b.timestamp - a.timestamp,
    )
    .slice(0, limit)
    .map((message, index) => ({
      label: formatResultLabel(message, query, index + 1),
      message,
    }));
}

/** Extract plain text from string or text-block message content. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join("\n");
}

/** Build a compact, unique label for one picker result. */
function formatResultLabel(message: SearchableMessage, query: string, index: number): string {
  const when = Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString().slice(0, 10)
    : "unknown-date";
  const title = truncate(message.sessionTitle.replace(/\s+/g, " "), 28);
  const snippet = truncate(snippetAroundMatch(message.text, query).replace(/\s+/g, " "), 80);
  return `${index}. ${when} ${message.role} · ${title} · ${snippet}`;
}

/** Score exact and word-start matches above generic substring matches. */
function scoreMessage(message: SearchableMessage, normalizedQuery: string): number {
  const text = message.text.toLocaleLowerCase();
  const index = text.indexOf(normalizedQuery);
  if (index < 0) return 0;
  const wordStartBonus = index === 0 || /\s/.test(text[index - 1] ?? "") ? 50 : 0;
  return 1000 - Math.min(index, 500) + wordStartBonus;
}

/** Prefer a human-readable session name, then its first message, then its path. */
function sessionTitle(info: SessionInfo): string {
  return info.name?.trim() || info.firstMessage?.trim() || info.path;
}

/** Return a short text window centered near the first match. */
function snippetAroundMatch(text: string, query: string): string {
  const normalizedText = text.toLocaleLowerCase();
  const normalizedQuery = query.toLocaleLowerCase();
  const matchIndex = normalizedText.indexOf(normalizedQuery);
  if (matchIndex < 0) return text;

  const start = Math.max(0, matchIndex - 24);
  const end = Math.min(text.length, matchIndex + query.length + 56);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

/** Truncate long labels without splitting the ellipsis logic throughout the file. */
function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Interactive live-search component with an input and top-N result list. */
class HistorySearchComponent extends Container implements Focusable {
  private input: Input;
  private results: HistorySearchResult[] = [];
  private selectedIndex = 0;
  private focusedValue = false;
  private messages: readonly SearchableMessage[];
  private searchTheme: {
    fg(color: string, text: string): string;
    bold(text: string): string;
  };
  private chrome: PanelChrome;
  private keybindings: { matches(data: string, id: string): boolean };
  private done: (result: SearchableMessage | undefined) => void;
  private requestRender: () => void;

  /** Create a live history search UI over preloaded session messages. */
  constructor(
    messages: readonly SearchableMessage[],
    initialQuery: string,
    theme: { fg(color: string, text: string): string; bold(text: string): string },
    keybindings: { matches(data: string, id: string): boolean },
    done: (result: SearchableMessage | undefined) => void,
    requestRender: () => void,
  ) {
    super();
    this.messages = messages;
    this.searchTheme = theme;
    this.chrome = new PanelChrome(theme);
    this.keybindings = keybindings;
    this.done = done;
    this.requestRender = requestRender;
    this.input = new Input();
    this.input.setValue(initialQuery);
    this.addChild(this.input);
    this.refreshResults();
  }

  /** Replace the searched message set, usually after saved sessions finish loading. */
  setMessages(messages: readonly SearchableMessage[]): void {
    this.messages = messages;
    this.refreshResults();
    this.requestRender();
  }

  /** Propagate focus to the embedded input so terminal IME/cursor placement works. */
  get focused(): boolean {
    return this.focusedValue;
  }

  set focused(value: boolean) {
    this.focusedValue = value;
    this.input.focused = value;
  }

  /** Render the search box, top matches, and compact key help inside a border. */
  render(width: number): string[] {
    const contentWidth = width;
    const lines = this.input.render(Math.max(1, contentWidth));

    if (!this.input.getValue().trim()) {
      lines.push(this.searchTheme.fg("dim", "Type to search saved user messages…"));
    } else if (this.results.length === 0) {
      lines.push(this.searchTheme.fg("warning", "No matching user messages"));
    } else {
      for (let index = 0; index < this.results.length; index++) {
        lines.push(this.renderResult(index, contentWidth));
      }
    }

    lines.push(this.searchTheme.fg("dim", "↑↓ navigate • enter populate editor • esc cancel"));
    return this.chrome.render("history", width, lines);
  }

  /** Route navigation keys to the result list and all other text editing to the input. */
  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.results[this.selectedIndex]?.message;
      if (selected) this.done(selected);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) {
      this.refreshResults();
    }
    this.requestRender();
  }

  /** Clear cached child render state. */
  invalidate(): void {
    super.invalidate();
    this.input.invalidate();
  }

  /** Move the selected match, wrapping around the current live result set. */
  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    this.selectedIndex = (this.selectedIndex + delta + this.results.length) % this.results.length;
    this.requestRender();
  }

  /** Recompute the top matches for the current input value. */
  private refreshResults(): void {
    const query = this.input.getValue().trim();
    this.results = query ? searchMessages(this.messages, query, MAX_RESULTS) : [];
    this.selectedIndex = 0;
  }

  /** Render one result row with selection styling. */
  private renderResult(index: number, width: number): string {
    const prefix = index === this.selectedIndex ? "→ " : "  ";
    const label = truncate(this.results[index]?.label ?? "", Math.max(1, width - prefix.length));
    const line = `${prefix}${label}`;
    return index === this.selectedIndex ? this.searchTheme.fg("accent", line) : line;
  }
}

/** Pure helpers exposed for Node tests. */
export const __historySearchForTest = {
  entriesToSearchableMessages,
  messageText,
  searchMessages,
};
