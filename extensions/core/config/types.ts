import type { RedactionMode } from "../extensions/proxy/types.ts";
import type { PersistedPermissionConfig } from "../extensions/permissions/types.ts";
import type { SourceTarget } from "../extensions/tls/types.ts";

/** Current version of the project-local core settings file. */
export type CoreSettingsVersion = 1;

/** TLS settings persisted by core; secret material is intentionally excluded. */
export interface CoreTlsSettings {
  /** Non-secret client certificate source metadata. */
  target?: SourceTarget;
  /** When true, skip client TLS resolution at startup (no prompt, no client cert). */
  skip?: boolean;
}

/** Proxy settings persisted by core. */
export interface CoreProxySettings {
  /** Proxy audit settings. */
  audit?: {
    /** Whether sensitive request headers are redacted in audit records. */
    redact?: RedactionMode;
  };
}

/** Unified project-local settings for the poo-pi core extension bundle. */
export interface CoreSettings {
  /** Settings schema version. */
  version: CoreSettingsVersion;
  /** Tool permission settings. */
  permissions?: PersistedPermissionConfig;
  /** Client TLS settings. */
  tls?: CoreTlsSettings;
  /** Provider proxy settings. */
  proxy?: CoreProxySettings;
}
