import type { OutgoingHttpHeaders } from "node:http";
import { appendFile, mkdir, open, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  readCoreProxyRedactionMode,
  writeCoreProxyRedactionMode,
} from "../../config/persistence.ts";
import type { AuditRecord, AuditResponse, ProxyState, RedactionMode } from "./types.ts";

/** Bytes kept from each edge of a large audited request body. */
const AUDIT_BODY_EDGE_BYTES = 64 * 1024;
/** Largest request body stored as one whole decoded string. */
const MAX_WHOLE_AUDIT_BODY = AUDIT_BODY_EDGE_BYTES * 2;
/** How many recent audit records to keep in memory for fast status reads. */
const RECENT_LIMIT = 50;
/** How many recent write failures to retain for status. */
const WRITE_ERROR_LIMIT = 10;
/** How many trailing bytes of `index.jsonl` to scan when reading recent entries. */
const TAIL_BYTES = 64 * 1024;

/** Header names (lowercased, substring match) whose values are masked when redaction is `on`. */
const SENSITIVE_HEADER_PATTERNS = [
  "authorization",
  "cookie",
  "api-key",
  "api_key",
  "token",
  "secret",
];

/** Resolved on-disk locations for the audit store under `<cwd>/.pi/proxy-audit`. */
export interface AuditPaths {
  /** Audit root directory. */
  dir: string;
  /** Per-request JSON directory. */
  requestsDir: string;
  /** Append-only index of one JSON line per request. */
  indexPath: string;
}

/** Compute the audit store paths for a working directory. */
export function auditPaths(cwd: string): AuditPaths {
  const dir = join(cwd, ".pi", "proxy-audit");
  return {
    dir,
    requestsDir: join(dir, "requests"),
    indexPath: join(dir, "index.jsonl"),
  };
}

/**
 * Create the audit directories if needed and return the audit root plus the seed
 * for the audit-id counter, derived from the number of existing request files so
 * ids stay monotonic across process restarts.
 */
export async function ensureAuditStore(cwd: string): Promise<{ dir: string; seq: number }> {
  const paths = auditPaths(cwd);
  await mkdir(paths.requestsDir, { recursive: true });
  let seq = 0;
  try {
    seq = (await readdir(paths.requestsDir)).filter((file) => file.endsWith(".json")).length;
  } catch {
    // No prior requests directory contents; start the counter at zero.
  }
  return { dir: paths.dir, seq };
}

/** Read the redaction mode fresh per request so a `/proxy-audit redact` flip takes effect live; defaults to `on`. */
export async function readRedactionMode(auditDir: string): Promise<RedactionMode> {
  return readCoreProxyRedactionMode(auditDir);
}

/** Persist the redaction mode for subsequent requests in unified core settings. */
export async function writeRedactionMode(auditDir: string, mode: RedactionMode): Promise<void> {
  await writeCoreProxyRedactionMode(auditDir, mode);
}

/** Inputs for building one audit record from a forwarded request and its outcome. */
export interface AuditInput {
  /** Zero-padded record id (also used in the file name). */
  id: string;
  /** Provider the route belongs to. */
  provider: string;
  /** HTTP method. */
  method: string;
  /** Inbound local proxy path. */
  url: string;
  /** Resolved upstream URL. */
  upstreamUrl: string;
  /** Forwarded headers (pre-redaction). */
  headers: OutgoingHttpHeaders;
  /** Fully-buffered request body, if any. */
  body?: Buffer;
  /** Redaction mode read for this request. */
  mode: RedactionMode;
  /** Captured response side. */
  response: AuditResponse;
}

/**
 * Build an audit record, applying header redaction when the switch is `on` and
 * capturing large request bodies as head/tail slices. The model id is parsed from
 * the request body when present.
 */
export function buildAuditRecord(input: AuditInput): AuditRecord {
  const bodyText = input.body?.toString("utf8");
  return {
    id: input.id,
    timestamp: new Date().toISOString(),
    provider: input.provider,
    model: parseModel(bodyText),
    request: {
      method: input.method,
      url: input.url,
      upstreamUrl: input.upstreamUrl,
      headers: normalizeHeaders(input.headers, input.mode),
      ...captureBody(input.body),
    },
    response: input.response,
  };
}

/**
 * Persist an audit record best-effort and off the response-forwarding path:
 * update the in-memory recent ring, write the per-request JSON atomically
 * (tmp + rename), and append the index line. Write failures are swallowed and
 * recorded in `state.writeErrors` rather than propagated to live traffic.
 */
export async function persistAuditRecord(state: ProxyState, record: AuditRecord): Promise<void> {
  pushBounded(state.recent, record, RECENT_LIMIT);
  if (!state.auditDir) return;

  const paths = auditPathsForDir(state.auditDir);
  const fileName = `${record.id}-${sanitize(record.provider)}-${sanitize(record.model ?? "model")}.json`;
  const finalPath = join(paths.requestsDir, fileName);
  const tmpPath = `${finalPath}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(tmpPath, finalPath);
    await appendFile(paths.indexPath, `${JSON.stringify(indexRecord(record))}\n`, { mode: 0o600 });
  } catch (error) {
    pushBounded(
      state.writeErrors,
      `audit write failed: ${describeError(error)}`,
      WRITE_ERROR_LIMIT,
    );
  }
}

/**
 * Read the most recent audit records by scanning only the tail of `index.jsonl`,
 * so the read stays fast as the log grows.
 *
 * @param auditDir Audit root directory.
 * @param limit Maximum number of records to return (most recent last).
 */
export async function readRecentTail(auditDir: string, limit: number): Promise<AuditRecord[]> {
  const lines = await readTailLines(auditPathsForDir(auditDir).indexPath, TAIL_BYTES);
  const records: AuditRecord[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch {
      // Skip a torn or partial trailing line rather than failing the whole read.
    }
  }
  return records;
}

/** Allocate the next zero-padded audit id and advance the counter. */
export function nextAuditId(state: ProxyState): string {
  state.auditSeq += 1;
  return String(state.auditSeq).padStart(6, "0");
}

/** Build audit paths from an already-resolved audit root directory. */
function auditPathsForDir(dir: string): AuditPaths {
  return {
    dir,
    requestsDir: join(dir, "requests"),
    indexPath: join(dir, "index.jsonl"),
  };
}

/** Build the body audit payload, preserving both edges when the body is large. */
function captureBody(
  body: Buffer | undefined,
): Pick<
  AuditRecord["request"],
  "body" | "bodyHead" | "bodyTail" | "bodyBytes" | "bodyOmittedBytes" | "bodyTruncated"
> {
  if (!body) return {};
  const bodyBytes = body.length;
  if (bodyBytes <= MAX_WHOLE_AUDIT_BODY) return { body: body.toString("utf8"), bodyBytes };

  return {
    bodyHead: body.subarray(0, AUDIT_BODY_EDGE_BYTES).toString("utf8"),
    bodyTail: body.subarray(bodyBytes - AUDIT_BODY_EDGE_BYTES).toString("utf8"),
    bodyBytes,
    bodyOmittedBytes: bodyBytes - MAX_WHOLE_AUDIT_BODY,
    bodyTruncated: true,
  };
}

/** Return a compact record for `index.jsonl`, omitting large body edge payloads. */
function indexRecord(record: AuditRecord): AuditRecord {
  if (!record.request.bodyTruncated) return record;
  const request = { ...record.request };
  delete request.body;
  delete request.bodyHead;
  delete request.bodyTail;
  return { ...record, request };
}

/** Mask sensitive header values when redaction is `on`; otherwise pass everything through raw. */
function normalizeHeaders(
  headers: OutgoingHttpHeaders,
  mode: RedactionMode,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    out[name] = mode === "on" && isSensitive(name) ? "[redacted]" : text;
  }
  return out;
}

/** Whether a header name matches any sensitive pattern. */
function isSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((pattern) => lower.includes(pattern));
}

/** Best-effort extraction of the model id from a JSON request body. */
function parseModel(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

/** Replace path-unsafe characters in file-name components. */
function sanitize(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-");
}

/** Push onto a bounded ring, dropping the oldest entries past `limit`. */
function pushBounded<T>(ring: T[], value: T, limit: number): void {
  ring.push(value);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}

/** Read the trailing `maxBytes` of a file and return its complete lines. */
async function readTailLines(path: string, maxBytes: number): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    let text = buf.toString("utf8");
    // Drop a partial first line when we did not start at the beginning of the file.
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text.split("\n").filter((line) => line.length > 0);
  } finally {
    await handle.close();
  }
}

/** Render an unknown thrown value as a short message. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
