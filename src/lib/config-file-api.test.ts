/**
 * `GET`/`PUT /api/config/file` over real HTTP: who may read and write it, what
 * the write refuses, and what it promises about restarts.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { BridgeConfig } from "./config.js";
import { readConfigFile, type ConfigFileState } from "./config-file.js";
import { startBridgeServer } from "./server.js";

let tmpDir: string;
let configFilePath: string;

function fileState(overrides: Partial<ConfigFileState> = {}): ConfigFileState {
  return {
    path: configFilePath,
    exists: false,
    values: {},
    warnings: [],
    sources: {},
    ...overrides,
  };
}

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
    configFile: fileState(),
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
    ...overrides,
  };
}

type Fetched = { status: number; json: Record<string, unknown> };

async function fetchServer(
  server: http.Server,
  urlPath: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<Fetched> {
  const port = (server.address() as { port: number })?.port;
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      {
        method: options.method ?? "GET",
        headers: {
          ...(payload ? { "content-type": "application/json" } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
          } catch {
            parsed = {};
          }
          resolve({ status: res.statusCode ?? 0, json: parsed });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-cfgfile-"));
  configFilePath = path.join(tmpDir, "config.json");
});

afterEach(async () => {
  for (const s of servers) await new Promise((r) => s.close(r));
  servers = [];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("GET /api/config/file", () => {
  it("reports the path, contents and per-key sources", async () => {
    const server = await start(
      createTestConfig({
        timeoutMs: 45_000,
        configFile: fileState({
          exists: true,
          values: { timeoutMs: 45_000 },
          sources: { timeoutMs: "file", defaultModel: "env", verbose: "cli" },
        }),
      }),
    );

    const res = await fetchServer(server, "/api/config/file");
    expect(res.status).toBe(200);
    expect(res.json.path).toBe(configFilePath);
    expect(res.json.exists).toBe(true);
    expect(res.json.values).toEqual({ timeoutMs: 45_000 });
    expect(res.json.sources).toMatchObject({ timeoutMs: "file", verbose: "cli" });
    // The effective view comes from the running config, not from the file.
    expect((res.json.effective as Record<string, unknown>).timeoutMs).toBe(45_000);
    expect(Array.isArray(res.json.keys)).toBe(true);
    expect(res.json.refusedKeys).toContain("apiKey");
  });

  it("is a sensitive read behind the dashboard gate", async () => {
    const server = await start(createTestConfig({ dashboardKey: "dash" }));

    expect((await fetchServer(server, "/api/config/file")).status).toBe(401);
    expect(
      (
        await fetchServer(server, "/api/config/file", {
          headers: { authorization: "Bearer dash" },
        })
      ).status,
    ).toBe(200);
  });

  it("never leaks key material in the schema it publishes", async () => {
    const server = await start(
      createTestConfig({
        dashboardKey: "dash-secret",
        requiredKey: "bridge-secret",
        apiKeys: [{ label: "ops", scope: "admin", key: "ops-secret" }],
      }),
    );

    const res = await fetchServer(server, "/api/config/file", {
      headers: { authorization: "Bearer dash-secret" },
    });
    const serialized = JSON.stringify(res.json);
    expect(serialized).not.toContain("dash-secret");
    expect(serialized).not.toContain("bridge-secret");
    expect(serialized).not.toContain("ops-secret");
  });
});

describe("PUT /api/config/file", () => {
  it("writes validated values and reports what needs a restart", async () => {
    const server = await start(
      createTestConfig({
        configFile: fileState({ sources: { port: "default" } }),
      }),
    );

    const res = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { port: 9100, defaultModel: "gpt-5" } },
    });

    expect(res.status).toBe(200);
    expect(res.json.written).toEqual(["port", "defaultModel"]);
    expect(res.json.restartRequired).toContain("port");
    expect(readConfigFile(configFilePath).values).toEqual({
      port: 9100,
      defaultModel: "gpt-5",
    });
  });

  it("flags a written value the environment still overrides", async () => {
    const server = await start(
      createTestConfig({
        configFile: fileState({ sources: { port: "env" } }),
      }),
    );

    const res = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { port: 9100 } },
    });

    expect(res.json.noEffect).toEqual(["port"]);
    expect(res.json.restartRequired).toEqual([]);
  });

  it("refuses credential keys with 400 naming the key", async () => {
    const server = await start(createTestConfig());

    const res = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { apiKey: "sk-secret" } },
    });

    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain('"apiKey" is not allowed');
    expect(res.json.key).toBe("apiKey");
    expect(fs.existsSync(configFilePath)).toBe(false);
  });

  it("refuses keys the dashboard may not own", async () => {
    const server = await start(createTestConfig());

    const res = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { configDirs: ["/tmp/evil"] } },
    });

    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain("read-only from the dashboard");
  });

  it("rejects an invalid value without touching the file on disk", async () => {
    fs.writeFileSync(configFilePath, JSON.stringify({ port: 9100 }));
    const server = await start(
      createTestConfig({
        configFile: fileState({ exists: true, values: { port: 9100 } }),
      }),
    );

    const res = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { mode: "sideways" } },
    });

    expect(res.status).toBe(400);
    expect(String(res.json.error)).toContain('"mode" must be one of');
    expect(readConfigFile(configFilePath).values).toEqual({ port: 9100 });
  });

  it("warns about unknown keys but still writes the rest", async () => {
    const server = await start(createTestConfig());

    const res = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { port: 9100, nonsense: true } },
    });

    expect(res.status).toBe(200);
    expect((res.json.warnings as string[]).join(" ")).toContain(
      'unknown key "nonsense"',
    );
    expect(readConfigFile(configFilePath).values).toEqual({ port: 9100 });
  });

  it("is a mutation behind the dashboard gate", async () => {
    const server = await start(createTestConfig({ dashboardKey: "dash" }));

    const denied = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { port: 9100 } },
    });
    expect(denied.status).toBe(401);
    expect(fs.existsSync(configFilePath)).toBe(false);

    const allowed = await fetchServer(server, "/api/config/file", {
      method: "PUT",
      headers: { authorization: "Bearer dash" },
      body: { values: { port: 9100 } },
    });
    expect(allowed.status).toBe(200);
  });

  it("records the write in the audit log", async () => {
    const server = await start(createTestConfig());

    await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { port: 9100 } },
    });

    let lines: string[] = [];
    for (let attempt = 0; attempt < 50 && lines.length === 0; attempt++) {
      if (fs.existsSync(path.join(tmpDir, "audit.jsonl"))) {
        lines = fs
          .readFileSync(path.join(tmpDir, "audit.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean);
      }
      if (lines.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.route).toBe("/api/config/file");
    expect(record.method).toBe("PUT");
    expect(record.outcome).toBe("ok");
  });

  it("serves the updated contents back without waiting for a restart", async () => {
    const server = await start(createTestConfig());

    await fetchServer(server, "/api/config/file", {
      method: "PUT",
      body: { values: { port: 9100 } },
    });
    const res = await fetchServer(server, "/api/config/file");

    expect(res.json.values).toEqual({ port: 9100 });
    expect(res.json.exists).toBe(true);
  });
});
