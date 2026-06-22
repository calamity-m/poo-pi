import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Custom session-entry type used by insights-report for Pi compaction metadata. */
export const COMPACTION_METADATA_CUSTOM_TYPE = "poo-pi.compaction-metadata";

/** Compaction trigger reasons exposed by Pi compaction events. */
type CompactionReason = "manual" | "threshold" | "overflow";

/** Runtime shape used while supporting older local Pi typings. */
type SessionCompactEventWithReason = {
  reason?: unknown;
  willRetry?: unknown;
};

/** Persisted metadata linking a compaction entry to its trigger reason. */
interface CompactionMetadataEntry {
  compactionEntryId: string;
  reason: CompactionReason;
  willRetry: boolean;
  fromExtension: boolean;
}

/**
 * Persist compaction trigger metadata for offline reporting tools.
 *
 * Pi exposes the trigger on extension events, but compaction session entries do
 * not store it directly. Recording a small custom entry lets the insights-report
 * skill distinguish manual compactions from automatic threshold/overflow ones
 * in future sessions without adding anything to LLM context.
 */
export function registerCompactionMetadata(pi: ExtensionAPI) {
  pi.on("session_compact", async (event) => {
    const eventWithReason = event as SessionCompactEventWithReason;
    if (!isCompactionReason(eventWithReason.reason)) return;

    const data: CompactionMetadataEntry = {
      compactionEntryId: event.compactionEntry.id,
      reason: eventWithReason.reason,
      willRetry: eventWithReason.willRetry === true,
      fromExtension: event.fromExtension,
    };
    pi.appendEntry(COMPACTION_METADATA_CUSTOM_TYPE, data);
  });
}

/** Return true for compaction reasons emitted by Pi 0.79.10+. */
function isCompactionReason(value: unknown): value is CompactionReason {
  return value === "manual" || value === "threshold" || value === "overflow";
}
