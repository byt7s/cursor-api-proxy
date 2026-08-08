import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { accountsDir } = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-admin-acc-"));
  return { accountsDir };
});

vi.mock("../cli/constants.js", () => ({
  ACCOUNTS_DIR: accountsDir,
}));

import { writeApiKeyAccount } from "./account-api-key.js";
import {
  adminDashboardMatches,
  authorizeDashboardApi,
} from "./admin-dashboard.js";
import type { BridgeConfig } from "./config.js";
import { startBridgeServer } from "./server.js";

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
  runResetHwid: vi.fn().mockResolvedValue({
    ok: true,
    dryRun: false,
    deepClean: false,
  }),
  handleResetHwid: vi.fn(),
}));

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
    sessionsLogPath: path.join(os.tmpdir(), `cap-admin-${Date.now()}.log`),
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
    requestsLogPath: "/tmp/cursor-api-proxy-test-requests.jsonl",
    apiKeys: [],
    keyRateLimitPerMin: 0,
    auditLogPath: "/tmp/cursor-api-proxy-test-audit.jsonl",
    auditLogEnabled: false,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    configFile: EMPTY_CONFIG_FILE_STATE,
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: true,
    latencyWaterfall: true,
    thoughtMode: "drop",
    toolCalls: false,
    ignoreImages: false,
    ...overrides,
  };
}

async function fetchServer(
  server: http.Server,
  urlPath: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string; json: unknown }> {
  const port = (server.address() as { port: number })?.port;
  const url = `http://127.0.0.1:${port}${urlPath}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let json: unknown = null;
          try {
            json = body ? JSON.parse(body) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, body, json });
        });
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("authorizeDashboardApi", () => {
  it("requires bearer when requiredKey is set", () => {
    const config = createTestConfig({ requiredKey: "secret" });
    const req = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    const denied = authorizeDashboardApi(req, config, "mutate");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(401);

    const okReq = {
      headers: { authorization: "Bearer secret" },
      socket: { remoteAddress: "10.0.0.5" },
    } as unknown as http.IncomingMessage;
    expect(authorizeDashboardApi(okReq, config, "mutate").ok).toBe(true);
  });

  it("rejects non-loopback mutations when requiredKey is unset", () => {
    const config = createTestConfig({ requiredKey: undefined });
    const remote = {
      headers: {},
      socket: { remoteAddress: "203.0.113.9" },
    } as unknown as http.IncomingMessage;
    const denied = authorizeDashboardApi(remote, config, "mutate");
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);

    const loop = {
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage;
    expect(authorizeDashboardApi(loop, config, "mutate").ok).toBe(true);
  });

  it("allows sensitive reads without bearer when requiredKey is unset", () => {
    const config = createTestConfig({ requiredKey: undefined });
    const remote = {
      headers: {},
      socket: { remoteAddress: "203.0.113.9" },
    } as unknown as http.IncomingMessage;
    expect(authorizeDashboardApi(remote, config, "sensitiveRead").ok).toBe(true);
  });
});

describe("adminDashboardMatches", () => {
  it("matches new mutating account routes", () => {
    expect(
      adminDashboardMatches({
        method: "POST",
        url: "/api/accounts",
      } as http.IncomingMessage),
    ).toBe(true);
    expect(
      adminDashboardMatches({
        method: "DELETE",
        url: "/api/accounts/work",
      } as http.IncomingMessage),
    ).toBe(true);
    expect(
      adminDashboardMatches({
        method: "PUT",
        url: "/api/accounts/work/key",
      } as http.IncomingMessage),
    ).toBe(true);
  });
});

describe("admin dashboard HTTP APIs", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
    fs.rmSync(accountsDir, { recursive: true, force: true });
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  async function start(config: BridgeConfig): Promise<http.Server> {
    const started = startBridgeServer({ version: "9.9.9", config });
    servers = started as http.Server[];
    await new Promise<void>((resolve) => servers[0].on("listening", () => resolve()));
    return servers[0];
  }

  it("GET /api/config requires bearer when requiredKey is set", async () => {
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const denied = await fetchServer(server, "/api/config");
    expect(denied.status).toBe(401);

    const ok = await fetchServer(server, "/api/config", {
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(ok.status).toBe(200);
    const cfg = ok.json as Record<string, unknown>;
    expect(cfg.maxConcurrentRuns).toBe(16);
    expect(cfg.sdkMaxConcurrentRuns).toBe(48);
    expect(cfg.requiredKey).toBe(true);
    expect(JSON.stringify(cfg)).not.toContain("bridge-secret");
  });

  it("serves the SPA shell on GET / without Authorization", async () => {
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const page = await fetchServer(server, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<div id="root">');
    expect(page.body).toContain("/static/dashboard/assets/");
  });

  it("serves the same SPA shell on GET /wiki", async () => {
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const root = await fetchServer(server, "/");
    const wiki = await fetchServer(server, "/wiki");
    expect(wiki.status).toBe(200);
    expect(wiki.body).toBe(root.body);
  });

  it("serves built dashboard assets under /static/dashboard/", async () => {
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const shell = await fetchServer(server, "/");
    const asset = /\/static\/(dashboard\/assets\/[\w.-]+\.js)/.exec(shell.body);
    expect(asset).not.toBeNull();
    const script = await fetchServer(server, `/static/${asset?.[1]}`);
    expect(script.status).toBe(200);
    expect(script.body.length).toBeGreaterThan(0);
  });

  it("POST /api/accounts creates an API-key account without echoing the key", async () => {
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const res = await fetchServer(server, "/api/accounts", {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "dash-acc", apiKey: "crsr_test_key_value" }),
    });
    expect(res.status).toBe(201);
    const body = res.json as { name: string; configDir: string };
    expect(body.name).toBe("dash-acc");
    expect(body.configDir).toContain("dash-acc");
    expect(JSON.stringify(res.json)).not.toContain("crsr_test_key_value");
    expect(
      fs.existsSync(path.join(accountsDir, "dash-acc", ".cursor-api-key")),
    ).toBe(true);
  });

  it("PUT /api/accounts/:name/key and DELETE /api/accounts/:name", async () => {
    writeApiKeyAccount(path.join(accountsDir, "keep"), "keep", "crsr_old");
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));

    const setKey = await fetchServer(server, "/api/accounts/keep/key", {
      method: "PUT",
      headers: {
        authorization: "Bearer bridge-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ apiKey: "crsr_new_key" }),
    });
    expect(setKey.status).toBe(200);
    expect(
      fs.readFileSync(path.join(accountsDir, "keep", ".cursor-api-key"), "utf8"),
    ).toBe("crsr_new_key");

    const del = await fetchServer(server, "/api/accounts/keep", {
      method: "DELETE",
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(del.status).toBe(200);
    expect(fs.existsSync(path.join(accountsDir, "keep"))).toBe(false);
  });

  it("GET /api/doctor returns checks JSON", async () => {
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const denied = await fetchServer(server, "/api/doctor");
    expect(denied.status).toBe(401);
    const ok = await fetchServer(server, "/api/doctor", {
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(ok.status).toBe(200);
    const body = ok.json as { ok: boolean; checks: unknown[] };
    expect(Array.isArray(body.checks)).toBe(true);
  });

  it("POST /api/reset-hwid requires auth and calls runResetHwid", async () => {
    const { runResetHwid } = await import("../cli/reset-hwid.js");
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const denied = await fetchServer(server, "/api/reset-hwid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deepClean: true }),
    });
    expect(denied.status).toBe(401);

    const ok = await fetchServer(server, "/api/reset-hwid", {
      method: "POST",
      headers: {
        authorization: "Bearer bridge-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({ deepClean: true }),
    });
    expect(ok.status).toBe(200);
    expect(runResetHwid).toHaveBeenCalledWith({ deepClean: true });
  });

  it("GET /api/accounts requires bearer and never echoes api keys", async () => {
    writeApiKeyAccount(
      path.join(accountsDir, "listed"),
      "listed",
      "crsr_secret_listed_key",
    );
    const server = await start(createTestConfig({ requiredKey: "bridge-secret" }));
    const denied = await fetchServer(server, "/api/accounts");
    expect(denied.status).toBe(401);

    const ok = await fetchServer(server, "/api/accounts", {
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(ok.status).toBe(200);
    const body = ok.json as {
      accounts: Array<{
        name: string;
        hasApiKey: boolean;
        configDir: string;
      }>;
    };
    expect(Array.isArray(body.accounts)).toBe(true);
    const listed = body.accounts.find((a) => a.name === "listed");
    expect(listed).toMatchObject({ name: "listed", hasApiKey: true });
    expect(JSON.stringify(ok.json)).not.toContain("crsr_secret_listed_key");
  });

  it("GET /api/requests requires bearer and returns recent request shape", async () => {
    const logPath = path.join(os.tmpdir(), `cap-admin-req-${Date.now()}.log`);
    fs.writeFileSync(
      logPath,
      `${new Date().toISOString()} POST /v1/chat/completions 127.0.0.1 200\n`,
      "utf8",
    );
    const server = await start(
      createTestConfig({
        requiredKey: "bridge-secret",
        sessionsLogPath: logPath,
      }),
    );
    const denied = await fetchServer(server, "/api/requests?limit=10");
    expect(denied.status).toBe(401);

    const ok = await fetchServer(server, "/api/requests?limit=10", {
      headers: { authorization: "Bearer bridge-secret" },
    });
    expect(ok.status).toBe(200);
    const body = ok.json as {
      path: string;
      requests: Array<{
        method: string;
        pathname: string;
        status: number;
        ts: string;
      }>;
    };
    expect(body.path).toBe(logPath);
    expect(body.requests.length).toBeGreaterThanOrEqual(1);
    expect(body.requests[0]).toMatchObject({
      method: "POST",
      pathname: "/v1/chat/completions",
      status: 200,
    });
    fs.rmSync(logPath, { force: true });
  });

  it("GET /api/requests serves structured records from the JSONL log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-admin-jsonl-"));
    const requestsLogPath = path.join(dir, "requests.jsonl");
    fs.writeFileSync(
      requestsLogPath,
      `${JSON.stringify({
        ts: "2026-08-08T00:00:00.000Z",
        method: "POST",
        pathname: "/v1/chat/completions",
        remoteAddress: "127.0.0.1",
        status: 503,
        durationMs: 1234,
        model: "auto",
        engine: "acp",
        account: "work",
        streaming: true,
        errorCode: "agent_capacity",
        failoverCount: 1,
        spans: { account_select: 3, model_first_byte: 900, total: 1234 },
      })}\n`,
      "utf8",
    );
    const server = await start(
      createTestConfig({ requestsLogEnabled: true, requestsLogPath }),
    );

    const ok = await fetchServer(server, "/api/requests?limit=10");
    expect(ok.status).toBe(200);
    const body = ok.json as {
      path: string;
      source: string;
      requests: Array<Record<string, unknown>>;
    };
    expect(body.source).toBe("jsonl");
    expect(body.path).toBe(requestsLogPath);
    expect(body.requests[0]).toMatchObject({
      method: "POST",
      pathname: "/v1/chat/completions",
      status: 503,
      durationMs: 1234,
      model: "auto",
      engine: "acp",
      account: "work",
      errorCode: "agent_capacity",
      spans: { account_select: 3, model_first_byte: 900, total: 1234 },
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("GET /api/requests falls back to the text log when the JSONL log is empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-admin-fallback-"));
    const sessionsLogPath = path.join(dir, "sessions.log");
    fs.writeFileSync(
      sessionsLogPath,
      `2026-08-08T00:00:00.000Z GET /healthz 127.0.0.1 200\n`,
      "utf8",
    );
    const server = await start(
      createTestConfig({
        sessionsLogPath,
        requestsLogEnabled: true,
        // Enabled but never written to yet.
        requestsLogPath: path.join(dir, "missing.jsonl"),
      }),
    );

    const ok = await fetchServer(server, "/api/requests?limit=10");
    expect(ok.status).toBe(200);
    const body = ok.json as {
      path: string;
      source: string;
      requests: Array<Record<string, unknown>>;
    };
    expect(body.source).toBe("text");
    expect(body.path).toBe(sessionsLogPath);
    expect(body.requests[0]).toMatchObject({
      method: "GET",
      pathname: "/healthz",
      status: 200,
    });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("allows loopback POST /api/accounts without bearer when requiredKey unset", async () => {
    const server = await start(createTestConfig({ requiredKey: undefined }));
    const res = await fetchServer(server, "/api/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "loop-acc", apiKey: "crsr_loop_key" }),
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.json)).not.toContain("crsr_loop_key");
    expect(
      fs.existsSync(path.join(accountsDir, "loop-acc", ".cursor-api-key")),
    ).toBe(true);
  });
});
