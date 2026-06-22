import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACTION_METADATA_CUSTOM_TYPE,
  registerCompactionMetadata,
} from "../extensions/core/extensions/compaction-metadata.ts";

/** Build the minimal ExtensionAPI stub needed by registerCompactionMetadata. */
function createPiStub() {
  let handler;
  const entries = [];
  return {
    entries,
    emit: (event) => handler?.(event),
    pi: {
      on: (eventName, registeredHandler) => {
        assert.equal(eventName, "session_compact");
        handler = registeredHandler;
      },
      appendEntry: (customType, data) => entries.push({ customType, data }),
    },
  };
}

test("compaction metadata hook persists known Pi compaction reasons", async () => {
  const stub = createPiStub();
  registerCompactionMetadata(stub.pi);

  await stub.emit({
    compactionEntry: { id: "c1" },
    fromExtension: false,
    reason: "overflow",
    willRetry: true,
  });

  assert.deepEqual(stub.entries, [
    {
      customType: COMPACTION_METADATA_CUSTOM_TYPE,
      data: {
        compactionEntryId: "c1",
        reason: "overflow",
        willRetry: true,
        fromExtension: false,
      },
    },
  ]);
});

test("compaction metadata hook skips older events without a reason", async () => {
  const stub = createPiStub();
  registerCompactionMetadata(stub.pi);

  await stub.emit({ compactionEntry: { id: "c1" }, fromExtension: false });
  await stub.emit({ compactionEntry: { id: "c2" }, fromExtension: false, reason: "unknown" });

  assert.deepEqual(stub.entries, []);
});
