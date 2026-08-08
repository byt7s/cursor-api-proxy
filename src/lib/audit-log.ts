/**
 * Audit trail for dashboard mutations (`audit.jsonl`).
 *
 * The dashboard can create and remove accounts, attach Cursor API keys, reset
 * the machine id and restart the service, so every mutating `/api/*` call is
 * recorded — including the ones that were refused, which are the interesting
 * ones when a key leaks. Records carry who (key label, or `loopback` when no
 * key was required), from where, what and the outcome. They never carry key
 * material: actors are labels, and any value that looks like a secret is
 * redacted before it is written.
 */

import * as path from "node:path";

import { appendJsonlRecord } from "./jsonl-log.js";

/** Default cap before the log is rotated to `<path>.1` (~8 MB). */
export const DEFAULT_AUDIT_LOG_MAX_BYTES = 8 * 1024 * 1024;

export type AuditOutcome = "ok" | "error";

export type AuditRecord = {
  ts: string;
  /** `METHOD /route`, e.g. `DELETE /api/accounts/:name`. */
  action: string;
  method: string;
  route: string;
  /** Key label, `dashboard-key`, or `loopback` when no key was required. */
  actor: string;
  /** Fingerprint of the key that authenticated, when there was one. */
  actorFingerprint?: string;
  remoteAddress: string;
  /** What the action operated on (account name, control action, …). */
  target?: string;
  outcome: AuditOutcome;
  status: number;
  /** Short reason when the outcome is an error. */
  error?: string;
};

/**
 * `Bearer …` is only treated as a secret when the token is not a
 * SHOUTY_SNAKE_CASE identifier, so a refusal that names the variable to set
 * ("Authorization Bearer CURSOR_BRIDGE_DASHBOARD_KEY required") stays legible.
 */
const SECRET_LIKE =
  /(crsr_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|Bearer\s+(?![A-Z0-9_]+(?:\s|$))[A-Za-z0-9._-]+)/g;

/** Belt-and-braces: no free-text field may carry something key-shaped. */
export function redactSecrets(value: string): string {
  return value.replace(SECRET_LIKE, "[redacted]");
}

export type AuditLogOptions = {
  enabled: boolean;
  logPath: string;
  maxBytes: number;
};

export type BuildAuditRecordInput = {
  ts?: string;
  method: string;
  route: string;
  actor: string;
  actorFingerprint?: string;
  remoteAddress: string;
  target?: string;
  status: number;
  error?: string;
};

export function buildAuditRecord(input: BuildAuditRecordInput): AuditRecord {
  const record: AuditRecord = {
    ts: input.ts ?? new Date().toISOString(),
    action: `${input.method} ${input.route}`,
    method: input.method,
    route: input.route,
    actor: redactSecrets(input.actor),
    remoteAddress: input.remoteAddress,
    outcome: input.status >= 400 ? "error" : "ok",
    status: input.status,
  };
  if (input.actorFingerprint) record.actorFingerprint = input.actorFingerprint;
  if (input.target) record.target = redactSecrets(input.target).slice(0, 200);
  if (input.error) record.error = redactSecrets(input.error).slice(0, 200);
  return record;
}

export function appendAuditRecord(
  record: AuditRecord,
  options: AuditLogOptions,
): void {
  if (!options.enabled) return;
  appendJsonlRecord(
    record,
    { logPath: options.logPath, maxBytes: options.maxBytes },
    "audit log",
  );
}

export function parseAuditRecordLine(line: string): AuditRecord | null {
  if (!line.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Partial<AuditRecord>;
  if (
    typeof candidate.ts !== "string" ||
    typeof candidate.action !== "string" ||
    typeof candidate.status !== "number"
  ) {
    return null;
  }
  return {
    ...candidate,
    method: candidate.method ?? "?",
    route: candidate.route ?? candidate.action,
    actor: candidate.actor ?? "unknown",
    remoteAddress: candidate.remoteAddress ?? "unknown",
    outcome: candidate.outcome === "error" ? "error" : "ok",
  } as AuditRecord;
}

/** Newest first, mirroring `recentRequestRecords`. */
export function recentAuditRecords(
  lines: string[],
  limit: number,
): AuditRecord[] {
  const records: AuditRecord[] = [];
  for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
    const record = parseAuditRecordLine(lines[i]!);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Collapses `/api/accounts/work/key` into `/api/accounts/:name/key` so the
 * route field stays a bounded set and the account lands in `target` instead.
 */
export function auditRouteFor(pathname: string): {
  route: string;
  target?: string;
} {
  const withoutQuery = pathname.split("?")[0] ?? pathname;
  const accounts = /^\/api\/accounts\/([^/]+)(\/key)?$/.exec(withoutQuery);
  if (accounts) {
    return {
      route: `/api/accounts/:name${accounts[2] ?? ""}`,
      target: decodeURIComponent(accounts[1]!),
    };
  }
  return { route: withoutQuery };
}

/** Default location next to the other proxy state files. */
export function defaultAuditLogPath(home: string | undefined, cwd: string): string {
  if (home) return path.join(home, ".cursor-api-proxy", "audit.jsonl");
  return path.join(cwd, "audit.jsonl");
}
