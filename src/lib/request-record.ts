/**
 * Structured per-request records (one JSON object per line).
 *
 * The plain-text `sessions.log` stays exactly as it was for back-compat; this
 * writes a parallel JSONL stream with the fields the dashboard and metrics
 * need (timing, model, engine, account, latency spans, error code).
 *
 * Handlers contribute what only they know through `annotateRequest(res, …)`;
 * the request listener assembles the record when the response finishes. Only
 * whitelisted fields are serialized, so prompts and credentials cannot leak
 * into the log: conversation ids are stored as a short hash, and prompt or
 * completion sizes as character counts.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import type * as http from "node:http";
import * as path from "node:path";

import type { ExecutionEngine } from "./execution-engine.js";
import type {
  LatencySpanName,
  LatencyWaterfall,
} from "./latency-waterfall.js";
import type { SessionRequest } from "./session-log.js";

/** Default cap before the log is rotated to `<path>.1` (~32 MB). */
export const DEFAULT_REQUESTS_LOG_MAX_BYTES = 32 * 1024 * 1024;

export type RequestRecord = SessionRequest & {
  /** Wall-clock duration from listener entry to response finish. */
  durationMs: number;
  model?: string;
  engine?: ExecutionEngine;
  /** Account directory basename — never the full path. */
  account?: string;
  streaming?: boolean;
  /** Stable error code (e.g. `agent_capacity`, `all_rate_limited`). */
  errorCode?: string;
  /** How many accounts were abandoned before this response. */
  failoverCount?: number;
  spans?: Partial<Record<LatencySpanName, number>>;
  /** Whether the client sent a sticky conversation id. */
  hasConversation?: boolean;
  /** Short hash of that id — the raw value is never written. */
  conversationHash?: string;
  promptChars?: number;
  completionChars?: number;
};

export type RequestAnnotation = {
  model?: string;
  engine?: ExecutionEngine;
  /** Account config dir; stored as its basename. */
  account?: string;
  streaming?: boolean;
  errorCode?: string;
  failoverCount?: number;
  /** Hashed before it reaches the record. */
  conversationId?: string;
  promptChars?: number;
  completionChars?: number;
  /** Spans are read at finish time so late marks are included. */
  latency?: LatencyWaterfall;
};

const annotations = new WeakMap<http.ServerResponse, RequestAnnotation>();

/** Merge handler-known facts into the pending record for this response. */
export function annotateRequest(
  res: http.ServerResponse,
  patch: RequestAnnotation,
): void {
  const current = annotations.get(res);
  if (current) annotations.set(res, { ...current, ...patch });
  else annotations.set(res, { ...patch });
}

export function getRequestAnnotation(
  res: http.ServerResponse,
): RequestAnnotation | undefined {
  return annotations.get(res);
}

/** Adds one to `failoverCount` (called when an account is abandoned). */
export function countRequestFailover(res: http.ServerResponse): void {
  const current = annotations.get(res);
  annotateRequest(res, { failoverCount: (current?.failoverCount ?? 0) + 1 });
}

export function hashConversationId(conversationId: string): string {
  return crypto
    .createHash("sha256")
    .update(conversationId)
    .digest("hex")
    .slice(0, 12);
}

export type BuildRequestRecordInput = {
  ts?: string;
  method: string;
  pathname: string;
  remoteAddress: string;
  status: number;
  durationMs: number;
  annotation?: RequestAnnotation;
};

export function buildRequestRecord(
  input: BuildRequestRecordInput,
): RequestRecord {
  const a = input.annotation ?? {};
  const spans = a.latency?.snapshot().spans;
  const record: RequestRecord = {
    ts: input.ts ?? new Date().toISOString(),
    method: input.method,
    pathname: input.pathname,
    remoteAddress: input.remoteAddress,
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
  };
  if (a.model) record.model = a.model;
  if (a.engine) record.engine = a.engine;
  if (a.account) record.account = path.basename(a.account);
  if (a.streaming !== undefined) record.streaming = a.streaming;
  if (a.errorCode) record.errorCode = a.errorCode;
  if (a.failoverCount) record.failoverCount = a.failoverCount;
  if (spans && Object.keys(spans).length > 0) record.spans = spans;
  if (a.conversationId) {
    record.hasConversation = true;
    record.conversationHash = hashConversationId(a.conversationId);
  }
  if (a.promptChars !== undefined) record.promptChars = a.promptChars;
  if (a.completionChars !== undefined) {
    record.completionChars = a.completionChars;
  }
  return record;
}

export type RequestsLogOptions = {
  enabled: boolean;
  logPath: string;
  maxBytes: number;
};

/** Rename to `<path>.1` once the file would exceed `maxBytes`. */
function rotateIfNeeded(
  logPath: string,
  maxBytes: number,
  incomingBytes: number,
): void {
  if (maxBytes <= 0) return;
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size + incomingBytes <= maxBytes) return;
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    console.error("Failed to rotate requests log:", err);
  }
}

export function appendRequestRecord(
  record: RequestRecord,
  options: RequestsLogOptions,
): void {
  if (!options.enabled) return;
  const line = `${JSON.stringify(record)}\n`;
  try {
    const dir = path.dirname(options.logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(options.logPath, options.maxBytes, Buffer.byteLength(line));
    fs.appendFileSync(options.logPath, line);
  } catch (err) {
    console.error("Failed to write requests log:", err);
  }
}

export function parseRequestRecordLine(line: string): RequestRecord | null {
  if (!line.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<RequestRecord>;
  if (
    typeof candidate.ts !== "string" ||
    typeof candidate.method !== "string" ||
    typeof candidate.pathname !== "string" ||
    typeof candidate.status !== "number"
  ) {
    return null;
  }
  return {
    ...candidate,
    remoteAddress: candidate.remoteAddress ?? "unknown",
    durationMs:
      typeof candidate.durationMs === "number" ? candidate.durationMs : 0,
  } as RequestRecord;
}

/** Newest first, mirroring `recentSessionRequests` for the text log. */
export function recentRequestRecords(
  lines: string[],
  limit: number,
): RequestRecord[] {
  const records: RequestRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    const record = parseRequestRecordLine(lines[i]!);
    if (record) records.push(record);
  }
  return records;
}
