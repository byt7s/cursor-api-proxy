import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendAuditRecord,
  auditRouteFor,
  buildAuditRecord,
  defaultAuditLogPath,
  parseAuditRecordLine,
  recentAuditRecords,
  redactSecrets,
} from "./audit-log.js";

let dir: string;
let logPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-audit-"));
  logPath = path.join(dir, "audit.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildAuditRecord", () => {
  it("derives the action and marks 2xx as ok", () => {
    const record = buildAuditRecord({
      method: "DELETE",
      route: "/api/accounts/:name",
      actor: "ops",
      actorFingerprint: "a1b2c3",
      remoteAddress: "127.0.0.1",
      target: "work",
      status: 200,
    });
    expect(record).toMatchObject({
      action: "DELETE /api/accounts/:name",
      actor: "ops",
      actorFingerprint: "a1b2c3",
      target: "work",
      outcome: "ok",
      status: 200,
    });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("marks 4xx and 5xx as errors and keeps the refusal reason", () => {
    const record = buildAuditRecord({
      method: "POST",
      route: "/api/accounts",
      actor: "anonymous",
      remoteAddress: "203.0.113.9",
      status: 403,
      error: "Mutating dashboard APIs require CURSOR_BRIDGE_DASHBOARD_KEY",
    });
    expect(record.outcome).toBe("error");
    expect(record.error).toContain("CURSOR_BRIDGE_DASHBOARD_KEY");
  });

  it("redacts key-shaped values out of actor, target and error", () => {
    const record = buildAuditRecord({
      method: "PUT",
      route: "/api/accounts/:name/key",
      actor: "Bearer sk-leaked-token",
      remoteAddress: "127.0.0.1",
      target: "crsr_leaked_account_key",
      status: 400,
      error: "rejected sk-another-leak",
    });
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("sk-leaked-token");
    expect(serialized).not.toContain("crsr_leaked_account_key");
    expect(serialized).not.toContain("sk-another-leak");
    expect(record.target).toBe("[redacted]");
  });
});

describe("redactSecrets", () => {
  it("replaces crsr_, sk- and Bearer values", () => {
    expect(redactSecrets("key=crsr_abc123 and sk-def456")).toBe(
      "key=[redacted] and [redacted]",
    );
    expect(redactSecrets("Authorization: Bearer abc.def-123")).toBe(
      "Authorization: [redacted]",
    );
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("removed account work-2")).toBe(
      "removed account work-2",
    );
  });

  it("keeps a variable name that follows Bearer readable", () => {
    expect(
      redactSecrets("Authorization Bearer CURSOR_BRIDGE_DASHBOARD_KEY required"),
    ).toBe("Authorization Bearer CURSOR_BRIDGE_DASHBOARD_KEY required");
  });
});

describe("appendAuditRecord", () => {
  const record = buildAuditRecord({
    method: "POST",
    route: "/api/control",
    actor: "loopback",
    remoteAddress: "127.0.0.1",
    target: "restart",
    status: 200,
  });

  it("writes one JSON line and creates the directory", () => {
    const nested = path.join(dir, "nested", "audit.jsonl");
    appendAuditRecord(record, {
      enabled: true,
      logPath: nested,
      maxBytes: 1_000_000,
    });
    const lines = fs.readFileSync(nested, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      action: "POST /api/control",
      target: "restart",
    });
  });

  it("writes nothing when disabled", () => {
    appendAuditRecord(record, {
      enabled: false,
      logPath,
      maxBytes: 1_000_000,
    });
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("rotates to <path>.1 once the file would exceed maxBytes", () => {
    const options = { enabled: true, logPath, maxBytes: 400 };
    for (let i = 0; i < 12; i++) {
      appendAuditRecord(
        buildAuditRecord({
          method: "POST",
          route: "/api/control",
          actor: "loopback",
          remoteAddress: "127.0.0.1",
          target: `restart-${i}`,
          status: 200,
        }),
        options,
      );
    }
    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(400);
  });

  it("never rotates when maxBytes is 0", () => {
    const options = { enabled: true, logPath, maxBytes: 0 };
    for (let i = 0; i < 12; i++) appendAuditRecord(record, options);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
  });
});

describe("parseAuditRecordLine and recentAuditRecords", () => {
  it("skips lines that are not audit records", () => {
    expect(parseAuditRecordLine("not json")).toBeNull();
    expect(parseAuditRecordLine("{broken")).toBeNull();
    expect(parseAuditRecordLine(JSON.stringify({ ts: "x" }))).toBeNull();
  });

  it("returns the newest records first, up to the limit", () => {
    const lines = [1, 2, 3].map((n) =>
      JSON.stringify(
        buildAuditRecord({
          ts: `2026-08-0${n}T00:00:00.000Z`,
          method: "POST",
          route: "/api/control",
          actor: "loopback",
          remoteAddress: "127.0.0.1",
          target: `run-${n}`,
          status: 200,
        }),
      ),
    );
    const recent = recentAuditRecords(["garbage", ...lines], 2);
    expect(recent.map((r) => r.target)).toEqual(["run-3", "run-2"]);
  });
});

describe("auditRouteFor", () => {
  it("collapses the account name into the target", () => {
    expect(auditRouteFor("/api/accounts/work")).toEqual({
      route: "/api/accounts/:name",
      target: "work",
    });
    expect(auditRouteFor("/api/accounts/work%20two/key")).toEqual({
      route: "/api/accounts/:name/key",
      target: "work two",
    });
  });

  it("leaves fixed routes untouched", () => {
    expect(auditRouteFor("/api/control?x=1")).toEqual({
      route: "/api/control",
    });
  });
});

describe("defaultAuditLogPath", () => {
  it("lives beside the other proxy state files, or in cwd without a home", () => {
    expect(defaultAuditLogPath("/home/me", "/cwd")).toBe(
      path.join("/home/me", ".cursor-api-proxy", "audit.jsonl"),
    );
    expect(defaultAuditLogPath(undefined, "/cwd")).toBe(
      path.join("/cwd", "audit.jsonl"),
    );
  });
});
