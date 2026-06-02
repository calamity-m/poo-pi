import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { readPersistedTarget, writePersistedTarget } from "./persistence.ts";
export { hasPersistedClientTlsConfig } from "./persistence.ts";
import { createInteractivePassphraseProvider, createPfxFileSource } from "./pfx-source.ts";
import type { ClientTlsProvider, ClientTlsSource, ClientTlsState, PassphraseProvider, RedactedClientTlsStatus, SourceTarget } from "./types.ts";
export type { ClientTlsProvider, ClientTlsSource, LoadedClientTls, PassphraseProvider, RedactedClientTlsStatus, SourceTarget } from "./types.ts";

const STATUS_KEY = "core-tls";
const TLS_MEMORY_KEY = "__pooPiCoreTlsMemory";

interface ClientTlsMemory {
  /** Memory-only TLS state carried across Pi runtime reloads in the same Node process. */
  state: ClientTlsState;
}

/** Return the process-local TLS cache used to survive /reload and /new without persisting secrets. */
function getClientTlsMemory(): ClientTlsMemory {
  const globalScope = globalThis as typeof globalThis & { __pooPiCoreTlsMemory?: ClientTlsMemory };
  globalScope[TLS_MEMORY_KEY] ??= { state: { status: "unconfigured" } };
  return globalScope[TLS_MEMORY_KEY];
}

/** Register TLS startup resolution and return the lazy-read provider for consumers. */
export function registerTls(pi: ExtensionAPI): ClientTlsProvider {
  const memory = getClientTlsMemory();
  let state: ClientTlsState = memory.state;
  const sources = createSourceRegistry([createPfxFileSource()]);
  const passphrases = [createInteractivePassphraseProvider()];

  const provider: ClientTlsProvider = {
    getClientTls: () => (state.status === "loaded" ? state.tls : undefined),
    getClientTlsStatus: () => redactState(state),
  };

  pi.on("session_start", async (event, ctx) => {
    if (event.reason !== "startup") {
      // Pi rebinds extensions for /reload and /new; reuse same-process TLS instead of prompting again.
      state = memory.state;
      ctx.ui.setStatus(STATUS_KEY, state.status === "loaded" ? formatStatusLine(redactState(state)) : undefined);
      return;
    }

    ctx.ui.setStatus(STATUS_KEY, "tls: loading");
    state = await resolveClientTls(ctx, sources, passphrases);
    memory.state = state;
    ctx.ui.setStatus(STATUS_KEY, formatStatusLine(redactState(state)));
    if (state.status === "unconfigured" && !ctx.hasUI) ctx.ui.notify("tls: setup required; run /tls-setup interactively", "warning");
    if (state.status === "error" && !ctx.hasUI) ctx.ui.notify(state.message, "warning");
  });

  pi.registerCommand("tls-setup", {
    description: "Configure the core mTLS client certificate without exposing certificate secrets",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("tls: interactive setup requires a UI", "warning");
        return;
      }
      ctx.ui.setStatus(STATUS_KEY, "tls: setup");
      state = await resolveClientTls(ctx, sources, passphrases, { force: true });
      memory.state = state;
      const status = redactState(state);
      ctx.ui.setStatus(STATUS_KEY, formatStatusLine(status));
      ctx.ui.notify(status.message, state.status === "error" ? "error" : "info");
    },
  });

  return provider;
}

/** Resolve TLS through persisted config or the interactive three-stage wizard. */
export async function resolveClientTls(
  ctx: ExtensionContext,
  sources: ClientTlsSource[],
  passphrases: PassphraseProvider[],
  options: { force?: boolean } = {},
): Promise<ClientTlsState> {
  const saved = options.force ? undefined : await readPersistedTarget(ctx);
  if (saved) {
    const source = sources.find((candidate) => candidate.id === saved.sourceId);
    if (source && (await source.validateTarget(ctx, saved))) return loadWithProvider(ctx, source, saved, passphrases);
  }

  if (!ctx.hasUI) return { status: "unconfigured" };

  const source = await chooseSource(ctx, sources);
  if (!source) return { status: "unconfigured" };
  const target = await source.chooseTarget(ctx);
  if (!target) return { status: "unconfigured" };
  const loaded = await loadWithProvider(ctx, source, target, passphrases);
  if (loaded.status === "loaded") await writePersistedTarget(ctx, target);
  return loaded;
}

/** Create a priority-ordered source registry without hard-coding consumer behavior to PFX. */
function createSourceRegistry(sources: ClientTlsSource[]): ClientTlsSource[] {
  return [...sources].sort((left, right) => left.priority - right.priority);
}

/** Stage 1 source picker; single-source registries auto-skip to keep today's UX direct. */
async function chooseSource(ctx: ExtensionContext, sources: ClientTlsSource[]): Promise<ClientTlsSource | undefined> {
  if (sources.length === 1) return sources[0];
  const labels = sources.map((source) => source.label);
  const selected = await ctx.ui.select("Choose TLS certificate source", labels);
  return sources.find((source) => source.label === selected);
}

/** Load a source with the first passphrase provider available in this context. */
async function loadWithProvider(
  ctx: ExtensionContext,
  source: ClientTlsSource,
  target: SourceTarget,
  passphrases: PassphraseProvider[],
): Promise<ClientTlsState> {
  const provider = source.needsPassphrase ? passphrases.find((candidate) => candidate.canProvide(ctx)) : createEmptyPassphraseProvider();
  if (!provider) return { status: "error", sourceId: source.id, message: "tls: passphrase requires interactive setup; run /tls-setup" };
  return source.load(ctx, target, provider);
}

/** Create a provider for sources that do not need a passphrase. */
function createEmptyPassphraseProvider(): PassphraseProvider {
  return {
    canProvide: () => true,
    getPassphrase: async () => "",
  };
}

/** Convert internal state to metadata-only status for UI and command output. */
function redactState(state: ClientTlsState): RedactedClientTlsStatus {
  if (state.status === "loaded") return { status: "loaded", sourceId: state.tls.sourceId, targetLabel: state.tls.targetLabel, message: "tls: loaded" };
  if (state.status === "error") return { status: "error", sourceId: state.sourceId, message: state.message };
  return { status: "unconfigured", message: "tls: unconfigured" };
}

/** Format a terse status line without paths, passphrase details, or certificate bytes. */
function formatStatusLine(status: RedactedClientTlsStatus): string {
  if (status.status === "loaded") return "tls: loaded";
  if (status.status === "error") return "tls: error";
  return "tls: unconfigured";
}
