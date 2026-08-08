/**
 * End-to-end coverage for the security gate: which credential opens which
 * route over real HTTP, what lands in the audit log, and the request
 * hardening (per-key throttle, body ceiling, CORS).
 */

import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { accountsDir } = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-sec-acc-"));
  return { accountsDir };
});

vi.mock("../cli/constants.js", () => ({
  ACCOUNTS_DIR: accountsDir,
}));

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./request-log.js", () => ({
  logIncoming: vi.fn(),
  logTrafficRequest: vi.fn(),
  logTrafficResponse: vi.fn(),
  logModelResolution: vi.fn(),
  logAgentError: vi.fn().mockReturnValue("agent error"),
  appendSessionLine: vi.fn(),
  logAccountAssigned: vi.fn(),
  logAccountStats: vi.fn(),
}));

vi.mock("../cli/reset-hwid.js", () => ({
  runResetHwid: vi.fn().mockResolvedValue({ ok: true, dryRun: false, deepClean: false }),
  handleResetHwid: vi.fn(),
}));

import type { AuditRecord } from "./audit-log.js";
import type { BridgeConfig } from "./config.js";
import { resetKeyRateLimits } from "./key-rate-limit.js";
import { startBridgeServer } from "./server.js";

let tmpDir: string;

function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: path.join(tmpDir, "sessions.log"),
    apiKeys: [],
    keyRateLimitPerMin: 0,
    auditLogPath: path.join(tmpDir, "audit.jsonl"),
    auditLogEnabled: true,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    configFile: EMPTY_CONFIG_FILE_STATE,
    requestsLogPath: path.join(tmpDir, "requests.jsonl"),
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: true,
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    defaultEngine: "acp",
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    admissionWaitMs: 0,
    latencyWaterfall: true,
    thoughtMode: "drop",
    toolCalls: false,
    ignoreImages: false,
    ...overrides,
  };
}

type Fetched = {
  status: number;
  body: string;
  json: unknown;
  headers: http.IncomingHttpHeaders;
};

async function fetchServer(
  server: http.Server,
  urlPath: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Fetched> {
  const port = (server.address() as { port: number })?.port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = body ? JSON.parse(body) : null;
          } catch {
            parsed = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
            json: parsed,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** The audit line is written on response finish, just after the client read. */
async function readAudit(logPath: string): Promise<AuditRecord[]> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (fs.existsSync(logPath)) {
      const lines = fs.readFileSync(logPath, "utf8").trim();
      if (lines) {
        return lines.split("\n").map((l) => JSON.parse(l) as AuditRecord);
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return [];
}

let servers: http.Server[] = [];

async function start(config: BridgeConfig): Promise<http.Server> {
  servers = startBridgeServer({ version: "9.9.9", config }) as http.Server[];
  await new Promise<void>((resolve) =>
    servers[0]!.on("listening", () => resolve()),
  );
  return servers[0]!;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-sec-"));
  resetKeyRateLimits();
});

afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(accountsDir, { recursive: true, force: true });
  fs.mkdirSync(accountsDir, { recursive: true });
});

describe("dashboard key precedence over HTTP", () => {
  it("requires the dashboard key and refuses the legacy key once it is set", async () => {
    const server = await start(
      createTestConfig({
        dashboardKey: "dash-secret",
        requiredKey: "bridge-secret",
        apiKeys: [{ label: "default", scope: "chat", key: "bridge-secret" }],
      }),
    );

    const anonymous = await fetchServer(server, "/api/config");
    expect(anonymous.status).toBe(401);

    const legacy = await fetchServer(server, "/api/config", {
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(legacy.status).toBe(403);

    const ok = await fetchServer(server, "/api/config", {
      headers: { authorization: "Bearer dash-secret" },
    });
    expect(ok.status).toBe(200);
    const cfg = ok.json as Record<string, unknown>;
    expect(cfg.dashboardKeyConfigured).toBe(true);
    expect(cfg.caller).toMatchObject({ actor: "dashboard-key" });
    expect(ok.body).not.toContain("dash-secret");
    expect(ok.body).not.toContain("bridge-secret");
  });

  it("keeps the legacy key working while no dashboard key is set", async () => {
    const server = await start(
      createTestConfig({
        requiredKey: "bridge-secret",
        apiKeys: [{ label: "default", scope: "chat", key: "bridge-secret" }],
      }),
    );
    const ok = await fetchServer(server, "/api/config", {
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(ok.status).toBe(200);
    expect((ok.json as { caller: { actor: string } }).caller.actor).toBe(
      "bridge-api-key",
    );
  });
});

describe("key scopes over HTTP", () => {
  const apiKeys = [
    { label: "ci", scope: "chat" as const, key: "sk-ci" },
    { label: "ops", scope: "admin" as const, key: "sk-ops" },
  ];

  it("lets an admin key mutate and reports it as the caller", async () => {
    const server = await start(createTestConfig({ apiKeys }));
    const created = await fetchServer(server, "/api/accounts", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ops",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "scoped", apiKey: "crsr_scoped_key" }),
    });
    expect(created.status).toBe(201);
    expect(created.body).not.toContain("crsr_scoped_key");

    const cfg = await fetchServer(server, "/api/config", {
      headers: { authorization: "Bearer sk-ops" },
    });
    expect((cfg.json as { caller: { actor: string } }).caller.actor).toBe("ops");
  });

  it("refuses a chat key on dashboard routes but allows it on LLM routes", async () => {
    const server = await start(createTestConfig({ apiKeys }));

    const denied = await fetchServer(server, "/api/accounts", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ci",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "nope", apiKey: "crsr_nope" }),
    });
    expect(denied.status).toBe(403);
    expect((denied.json as { error: string }).error).toContain('scope "chat"');

    const health = await fetchServer(server, "/health", {
      headers: { authorization: "Bearer sk-ci" },
    });
    expect(health.status).toBe(200);
  });

  it("exposes only labels, scopes and fingerprints in /api/config", async () => {
    const server = await start(createTestConfig({ apiKeys }));
    const cfg = await fetchServer(server, "/api/config", {
      headers: { authorization: "Bearer sk-ops" },
    });
    const keys = (cfg.json as { apiKeys: Array<Record<string, string>> }).apiKeys;
    expect(keys.map((k) => `${k.label}:${k.scope}`)).toEqual([
      "ci:chat",
      "ops:admin",
    ]);
    for (const key of keys) expect(key.fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(cfg.body).not.toContain("sk-ci");
    expect(cfg.body).not.toContain("sk-ops");
  });

  it("rejects an unknown key on LLM routes with 401", async () => {
    const server = await start(createTestConfig({ apiKeys }));
    const denied = await fetchServer(server, "/health", {
      headers: { authorization: "Bearer sk-unknown" },
    });
    expect(denied.status).toBe(401);
  });
});

describe("per-key rate limit", () => {
  it("answers 429 with Retry-After once the key exceeds its budget", async () => {
    const server = await start(
      createTestConfig({
        keyRateLimitPerMin: 2,
        apiKeys: [{ label: "ci", scope: "chat", key: "sk-ci" }],
      }),
    );
    const headers = { authorization: "Bearer sk-ci" };

    expect((await fetchServer(server, "/health", { headers })).status).toBe(200);
    expect((await fetchServer(server, "/health", { headers })).status).toBe(200);

    const limited = await fetchServer(server, "/health", { headers });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    expect((limited.json as { error: { code: string } }).error.code).toBe(
      "rate_limited",
    );
  });

  it("counts each key separately and stays off at the default", async () => {
    const apiKeys = [
      { label: "ci", scope: "chat" as const, key: "sk-ci" },
      { label: "ops", scope: "admin" as const, key: "sk-ops" },
    ];
    const limited = await start(createTestConfig({ keyRateLimitPerMin: 1, apiKeys }));
    await fetchServer(limited, "/health", {
      headers: { authorization: "Bearer sk-ci" },
    });
    expect(
      (
        await fetchServer(limited, "/health", {
          headers: { authorization: "Bearer sk-ci" },
        })
      ).status,
    ).toBe(429);
    expect(
      (
        await fetchServer(limited, "/health", {
          headers: { authorization: "Bearer sk-ops" },
        })
      ).status,
    ).toBe(200);
  });
});

describe("audit log", () => {
  it("records a successful mutation with actor, target and outcome", async () => {
    const auditLogPath = path.join(tmpDir, "audit.jsonl");
    const server = await start(
      createTestConfig({
        auditLogPath,
        apiKeys: [{ label: "ops", scope: "admin", key: "sk-ops" }],
      }),
    );

    await fetchServer(server, "/api/accounts", {
      method: "POST",
      headers: {
        authorization: "Bearer sk-ops",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "audited", apiKey: "crsr_audited_key" }),
    });

    const [record] = await readAudit(auditLogPath);
    expect(record).toMatchObject({
      action: "POST /api/accounts",
      actor: "ops",
      target: "audited",
      outcome: "ok",
      status: 201,
    });
    expect(record!.actorFingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(JSON.stringify(record)).not.toContain("crsr_audited_key");
    expect(JSON.stringify(record)).not.toContain("sk-ops");
  });

  it("records refused mutations with the reason", async () => {
    const auditLogPath = path.join(tmpDir, "audit.jsonl");
    const server = await start(
      createTestConfig({ auditLogPath, dashboardKey: "dash-secret" }),
    );

    await fetchServer(server, "/api/accounts/gone", {
      method: "DELETE",
      headers: { authorization: "Bearer wrong-key" },
    });

    const [record] = await readAudit(auditLogPath);
    expect(record).toMatchObject({
      action: "DELETE /api/accounts/:name",
      target: "gone",
      outcome: "error",
      status: 401,
      actor: "anonymous",
    });
    expect(record!.error).toContain("CURSOR_BRIDGE_DASHBOARD_KEY");
  });

  it("serves the log through GET /api/audit behind the same gate", async () => {
    const auditLogPath = path.join(tmpDir, "audit.jsonl");
    const server = await start(
      createTestConfig({ auditLogPath, dashboardKey: "dash-secret" }),
    );

    await fetchServer(server, "/api/control", {
      method: "POST",
      headers: {
        authorization: "Bearer dash-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "restart" }),
    });
    await readAudit(auditLogPath);

    const denied = await fetchServer(server, "/api/audit");
    expect(denied.status).toBe(401);

    const ok = await fetchServer(server, "/api/audit?limit=10", {
      headers: { authorization: "Bearer dash-secret" },
    });
    expect(ok.status).toBe(200);
    const payload = ok.json as {
      path: string;
      enabled: boolean;
      records: AuditRecord[];
    };
    expect(payload.enabled).toBe(true);
    expect(payload.path).toBe(auditLogPath);
    expect(payload.records[0]).toMatchObject({
      route: "/api/control",
      target: "restart",
      actor: "dashboard-key",
    });
  });

  it("writes nothing and reports disabled when audit logging is off", async () => {
    const auditLogPath = path.join(tmpDir, "audit.jsonl");
    const server = await start(
      createTestConfig({ auditLogPath, auditLogEnabled: false }),
    );

    await fetchServer(server, "/api/log/clear", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    const ok = await fetchServer(server, "/api/audit");
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ enabled: false, records: [] });
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });

  it("does not audit sensitive reads, only mutations", async () => {
    const auditLogPath = path.join(tmpDir, "audit.jsonl");
    const server = await start(createTestConfig({ auditLogPath }));
    await fetchServer(server, "/api/config");
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(auditLogPath)).toBe(false);
  });
});

describe("request hardening", () => {
  it("answers 413 for a body over CURSOR_BRIDGE_MAX_BODY_BYTES", async () => {
    const server = await start(createTestConfig({ maxBodyBytes: 200 }));
    const oversized = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "auto",
        messages: [{ role: "user", content: "x".repeat(1000) }],
      }),
    });
    expect(oversized.status).toBe(413);
    const error = (oversized.json as { error: { code: string; message: string } })
      .error;
    expect(error.code).toBe("payload_too_large");
    expect(error.message).toContain("CURSOR_BRIDGE_MAX_BODY_BYTES");
  });

  it("answers 413 on oversized dashboard mutations too", async () => {
    const server = await start(createTestConfig({ maxBodyBytes: 50 }));
    const oversized = await fetchServer(server, "/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(200), apiKey: "crsr_x" }),
    });
    expect(oversized.status).toBe(413);
  });

  it("emits no CORS headers when no origins are configured", async () => {
    const server = await start(createTestConfig());
    const res = await fetchServer(server, "/healthz", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("emits CORS headers and answers preflight for a listed origin", async () => {
    const server = await start(
      createTestConfig({ corsOrigins: ["http://localhost:5173"] }),
    );

    const preflight = await fetchServer(server, "/v1/chat/completions", {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
    expect(preflight.headers["access-control-allow-methods"]).toContain("POST");
    expect(preflight.headers["access-control-allow-headers"]).toContain(
      "authorization",
    );

    const actual = await fetchServer(server, "/healthz", {
      headers: { origin: "http://localhost:5173" },
    });
    expect(actual.status).toBe(200);
    expect(actual.headers["access-control-allow-origin"]).toBe(
      "http://localhost:5173",
    );
  });

  it("refuses preflight from an origin that is not listed", async () => {
    const server = await start(
      createTestConfig({ corsOrigins: ["http://localhost:5173"] }),
    );
    const preflight = await fetchServer(server, "/v1/chat/completions", {
      method: "OPTIONS",
      headers: { origin: "http://evil.example" },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("/metrics shares the dashboard gate", () => {
  it("accepts the dashboard key and refuses a chat key", async () => {
    const server = await start(
      createTestConfig({
        dashboardKey: "dash-secret",
        apiKeys: [{ label: "ci", scope: "chat", key: "sk-ci" }],
      }),
    );

    expect((await fetchServer(server, "/metrics")).status).toBe(401);
    expect(
      (
        await fetchServer(server, "/metrics", {
          headers: { authorization: "Bearer sk-ci" },
        })
      ).status,
    ).toBe(403);

    const ok = await fetchServer(server, "/metrics", {
      headers: { authorization: "Bearer dash-secret" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("cursor_proxy_build_info");
  });
});
