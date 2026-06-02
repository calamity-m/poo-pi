import type { SecureContext } from "node:tls";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Non-secret, persisted locator for a chosen client certificate source target. */
export interface SourceTarget {
  /** Source that owns this locator, such as `pfx-file`. */
  sourceId: string;
  /** Source-specific locator; for PFX this is an absolute file path and is treated as sensitive metadata. */
  locator: string;
  /** Human-facing label safe enough for local UI status; it should not contain full paths. */
  label: string;
}

/** TLS material consumers may use for outbound mTLS without receiving passphrases or raw PFX bytes. */
export interface LoadedClientTls {
  /** Source that produced the loaded TLS material. */
  sourceId: string;
  /** Redacted target label, normally a basename, never a full persisted path. */
  targetLabel: string;
  /** Node TLS secure context built from the client certificate and immediately-discarded passphrase. */
  secureContext: SecureContext;
  /** Metadata considered non-secret by this implementation; certificate material and passphrase details are excluded. */
  metadata: Record<string, never>;
}

/** Metadata-only status suitable for status lines, commands, and errors. */
export type RedactedClientTlsStatus =
  | { status: "unconfigured"; message: string }
  | { status: "loaded"; sourceId: string; targetLabel: string; message: string }
  | { status: "error"; sourceId?: string; message: string };

/** Module-private TLS state; only loaded state retains a SecureContext in process memory. */
export type ClientTlsState =
  | { status: "unconfigured" }
  | { status: "loaded"; tls: LoadedClientTls }
  | { status: "error"; sourceId?: string; message: string };

/** Provider passed to core consumers; it is deliberately not an LLM-callable Pi tool. */
export interface ClientTlsProvider {
  /** Return loaded TLS material, or undefined so consumers can fail closed instead of connecting without mTLS. */
  getClientTls(): LoadedClientTls | undefined;
  /** Return redacted status metadata safe for UI and command output. */
  getClientTlsStatus(): RedactedClientTlsStatus;
}

/** Secret provider seam; passphrases are used immediately by a source and never retained. */
export interface PassphraseProvider {
  /** Whether this provider can supply a passphrase in the current context. */
  canProvide(ctx: ExtensionContext): boolean;
  /** Prompt or otherwise obtain the passphrase for immediate use by the caller. */
  getPassphrase(ctx: ExtensionContext, prompt: string): Promise<string | undefined>;
}

/** Certificate source seam; source target selection is orthogonal to passphrase origin. */
export interface ClientTlsSource {
  /** Stable source id stored in the non-secret project-local config. */
  id: string;
  /** Human-facing source name for stage-1 selection. */
  label: string;
  /** Lower numbers are preferred when auto-selecting defaults. */
  priority: number;
  /** Whether this source needs a passphrase provider during load. */
  needsPassphrase: boolean;
  /** Stage-2 chooser owned by the source so future keyring/pass/PKCS#11 sources do not inherit PFX UI. */
  chooseTarget(ctx: ExtensionContext): Promise<SourceTarget | undefined>;
  /** Validate a persisted target before skipping source/target selection on later startups. */
  validateTarget(ctx: ExtensionContext, target: SourceTarget): Promise<boolean>;
  /** Load TLS material using an injected passphrase provider so secret origin stays independent of cert origin. */
  load(ctx: ExtensionContext, target: SourceTarget, passphrase: PassphraseProvider): Promise<ClientTlsState>;
}
