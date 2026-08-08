import * as fs from "node:fs";
import type * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LatencyWaterfall } from "./latency-waterfall.js";
import {
  annotateRequest,
  appendRequestRecord,
  buildRequestRecord,
  countRequestFailover,
  getRequestAnnotation,
  hashConversationId,
  parseRequestRecordLine,
  recentRequestRecords,
  type RequestRecord,
} from "./request-record.js";

const tmpDirs: string[] = [];

function tmpLogPath(name = "requests.jsonl"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-req-log-"));
  tmpDirs.push(dir);
  return path.join(dir, name);
}

/** Only the WeakMap identity matters, so a bare object is enough. */
function fakeRes(): http.ServerResponse {
  return {} as http.ServerResponse;
}

function readLines(logPath: string): string[] {
  return fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("annotateRequest", () => {
  it("merges patches per response and counts failovers", () => {
    const res = fakeRes();
    annotateRequest(res, { model: "auto", streaming: true });
    annotateRequest(res, { engine: "sdk", promptChars: 12 });
    countRequestFailover(res);
    countRequestFailover(res);

    expect(getRequestAnnotation(res)).toEqual({
      model: "auto",
      streaming: true,
      engine: "sdk",
      promptChars: 12,
      failoverCount: 2,
    });
  });

  it("keeps annotations of different responses apart", () => {
    const a = fakeRes();
    const b = fakeRes();
    annotateRequest(a, { model: "auto" });
    expect(getRequestAnnotation(b)).toBeUndefined();
  });
});

describe("buildRequestRecord", () => {
  const base = {
    ts: "2026-08-08T00:00:00.000Z",
    method: "POST",
    pathname: "/v1/chat/completions",
    remoteAddress: "127.0.0.1",
    status: 200,
    durationMs: 1234.6,
  };

  it("serializes the annotated fields", () => {
    const latency = new LatencyWaterfall();
    latency.mark("account_select_start");
    latency.mark("account_select_end");

    const record = buildRequestRecord({
      ...base,
      annotation: {
        model: "claude-4.5-sonnet",
        engine: "acp",
        account: "/Users/me/.cursor-api-proxy/accounts/work",
        streaming: true,
        errorCode: "agent_capacity",
        failoverCount: 2,
        promptChars: 480,
        completionChars: 1200,
        conversationId: "conv-abc",
        latency,
      },
    });

    expect(record).toMatchObject({
      ts: "2026-08-08T00:00:00.000Z",
      method: "POST",
      pathname: "/v1/chat/completions",
      remoteAddress: "127.0.0.1",
      status: 200,
      durationMs: 1235,
      model: "claude-4.5-sonnet",
      engine: "acp",
      account: "work",
      streaming: true,
      errorCode: "agent_capacity",
      failoverCount: 2,
      promptChars: 480,
      completionChars: 1200,
      hasConversation: true,
    });
    expect(typeof record.spans?.account_select).toBe("number");
    expect(typeof record.spans?.total).toBe("number");
  });

  it("omits everything the handler did not annotate", () => {
    const record = buildRequestRecord({ ...base, durationMs: 5 });
    expect(Object.keys(record).sort()).toEqual([
      "durationMs",
      "method",
      "pathname",
      "remoteAddress",
      "status",
      "ts",
    ]);
  });

  it("never stores the conversation id, prompts or credentials", () => {
    const record = buildRequestRecord({
      ...base,
      annotation: {
        conversationId: "conv-9d0f-secret",
        promptChars: 4096,
        model: "auto",
      },
    });

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("conv-9d0f-secret");
    expect(record.conversationHash).toBe(
      hashConversationId("conv-9d0f-secret"),
    );
    expect(record.conversationHash).toHaveLength(12);
    expect(record.hasConversation).toBe(true);
    // Only sizes are kept, never the text itself.
    expect(record.promptChars).toBe(4096);
    expect(serialized).not.toMatch(/prompt"\s*:\s*"/);
  });

  it("clamps a negative duration to zero", () => {
    expect(buildRequestRecord({ ...base, durationMs: -5 }).durationMs).toBe(0);
  });
});

describe("appendRequestRecord", () => {
  const record: RequestRecord = {
    ts: "2026-08-08T00:00:00.000Z",
    method: "POST",
    pathname: "/v1/chat/completions",
    remoteAddress: "127.0.0.1",
    status: 200,
    durationMs: 10,
  };

  it("appends one JSON object per line and creates the directory", () => {
    const logPath = path.join(tmpLogPath(), "nested", "requests.jsonl");
    appendRequestRecord(record, {
      enabled: true,
      logPath,
      maxBytes: 1_000_000,
    });
    appendRequestRecord(
      { ...record, status: 503 },
      { enabled: true, logPath, maxBytes: 1_000_000 },
    );

    const lines = readLines(logPath);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toMatchObject({ status: 200 });
    expect(JSON.parse(lines[1]!)).toMatchObject({ status: 503 });
  });

  it("writes nothing when disabled", () => {
    const logPath = tmpLogPath();
    appendRequestRecord(record, {
      enabled: false,
      logPath,
      maxBytes: 1_000_000,
    });
    expect(fs.existsSync(logPath)).toBe(false);
  });

  it("rotates to .1 once the file would exceed maxBytes", () => {
    const logPath = tmpLogPath();
    const lineBytes = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    const options = {
      enabled: true,
      logPath,
      maxBytes: lineBytes * 2,
    };

    appendRequestRecord(record, options);
    appendRequestRecord({ ...record, status: 201 }, options);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(readLines(logPath)).toHaveLength(2);

    appendRequestRecord({ ...record, status: 202 }, options);
    expect(readLines(`${logPath}.1`)).toHaveLength(2);
    const rolled = readLines(logPath);
    expect(rolled).toHaveLength(1);
    expect(JSON.parse(rolled[0]!)).toMatchObject({ status: 202 });
  });

  it("keeps a single generation of rotated history", () => {
    const logPath = tmpLogPath();
    const options = { enabled: true, logPath, maxBytes: 1 };
    appendRequestRecord(record, options);
    appendRequestRecord({ ...record, status: 201 }, options);
    appendRequestRecord({ ...record, status: 202 }, options);

    expect(fs.existsSync(`${logPath}.2`)).toBe(false);
    expect(JSON.parse(readLines(`${logPath}.1`)[0]!)).toMatchObject({
      status: 201,
    });
  });

  it("never rotates when maxBytes is zero", () => {
    const logPath = tmpLogPath();
    const options = { enabled: true, logPath, maxBytes: 0 };
    appendRequestRecord(record, options);
    appendRequestRecord({ ...record, status: 201 }, options);
    expect(fs.existsSync(`${logPath}.1`)).toBe(false);
    expect(readLines(logPath)).toHaveLength(2);
  });

  it("reports write failures without throwing", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-req-log-"));
    tmpDirs.push(dir);
    // The log path is an existing directory, so the append cannot succeed.
    expect(() =>
      appendRequestRecord(record, {
        enabled: true,
        logPath: dir,
        maxBytes: 1_000_000,
      }),
    ).not.toThrow();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("parseRequestRecordLine", () => {
  it("rejects text-log lines and malformed JSON", () => {
    expect(
      parseRequestRecordLine(
        "2026-08-08T00:00:00.000Z POST /v1/chat/completions 127.0.0.1 200",
      ),
    ).toBeNull();
    expect(parseRequestRecordLine("{not json")).toBeNull();
    expect(parseRequestRecordLine("{}")).toBeNull();
    expect(parseRequestRecordLine('{"ts":"x","method":"GET"}')).toBeNull();
  });

  it("fills defaults for records written by older versions", () => {
    const record = parseRequestRecordLine(
      '{"ts":"2026-08-08T00:00:00.000Z","method":"GET","pathname":"/healthz","status":200}',
    );
    expect(record).toMatchObject({
      remoteAddress: "unknown",
      durationMs: 0,
    });
  });
});

describe("recentRequestRecords", () => {
  it("returns newest first, capped at the limit, skipping junk", () => {
    const lines = [
      '{"ts":"2026-08-08T00:00:01.000Z","method":"GET","pathname":"/a","remoteAddress":"127.0.0.1","status":200,"durationMs":1}',
      "garbage",
      '{"ts":"2026-08-08T00:00:02.000Z","method":"GET","pathname":"/b","remoteAddress":"127.0.0.1","status":200,"durationMs":2}',
      '{"ts":"2026-08-08T00:00:03.000Z","method":"GET","pathname":"/c","remoteAddress":"127.0.0.1","status":200,"durationMs":3}',
    ];
    expect(recentRequestRecords(lines, 2).map((r) => r.pathname)).toEqual([
      "/c",
      "/b",
    ]);
    expect(recentRequestRecords(lines, 10)).toHaveLength(3);
  });
});
