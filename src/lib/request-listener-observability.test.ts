import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import type { BridgeConfig } from "./config.js";
import { resetMetricsForTests } from "./metrics.js";
import { startBridgeServer } from "./server.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({
    code: 0,
    stdout: "Hello from agent",
    stderr: "",
  }),
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

function createTestConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 0,
    defaultModel: "composer-2",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: path.join(os.tmpdir(), "cap-listener-obs-sessions.log"),
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
    apiKeys: [],
    keyRateLimitPerMin: 0,
    auditLogPath: path.join(os.tmpdir(), "cap-listener-obs-audit.jsonl"),
    auditLogEnabled: false,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    configFile: EMPTY_CONFIG_FILE_STATE,
    modelAliases: {},
    ignoreImages: false,
    requestsLogPath: path.join(os.tmpdir(), "cap-listener-obs-requests.jsonl"),
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: true,
    latencyWaterfall: false,
    thoughtMode: "drop",
    toolCalls: false,
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
): Promise<{ status: number; body: string }> {
  const port = (server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      {
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function waitForJsonl(
  logPath: string,
  minLines = 1,
  timeoutMs = 2000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(logPath)) {
      const lines = fs
        .readFileSync(logPath, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      if (lines.length >= minLines) return lines;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

describe("request listener observability wiring", () => {
  let tmpDir: string;
  let servers: http.Server[] = [];

  beforeEach(() => {
    resetMetricsForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-listener-obs-"));
  });

  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    servers = [];
    resetMetricsForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function start(overrides: Partial<BridgeConfig> = {}): Promise<http.Server> {
    const config = createTestConfig({
      requestsLogEnabled: true,
      requestsLogPath: path.join(tmpDir, "requests.jsonl"),
      sessionsLogPath: path.join(tmpDir, "sessions.log"),
      ...overrides,
    });
    servers = startBridgeServer({ version: "1.2.3", config }) as http.Server[];
    await new Promise<void>((resolve) =>
      servers[0]!.on("listening", () => resolve()),
    );
    return servers[0]!;
  }

  it("writes a JSONL request record and observes metrics for a proxied chat completion", async () => {
    const server = await start();
    const logPath = path.join(tmpDir, "requests.jsonl");

    const chat = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(chat.status).toBe(200);
    expect(JSON.parse(chat.body).choices[0].message.content).toBe(
      "Hello from agent",
    );

    const lines = await waitForJsonl(logPath, 1);
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const record = JSON.parse(lines[lines.length - 1]!) as {
      method: string;
      pathname: string;
      status: number;
      durationMs: number;
      model?: string;
    };
    expect(record.method).toBe("POST");
    expect(record.pathname).toBe("/v1/chat/completions");
    expect(record.status).toBe(200);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.model).toBe("composer-2");

    const metrics = await fetchServer(server, "/metrics");
    expect(metrics.status).toBe(200);
    expect(metrics.body).toContain('route="/v1/chat/completions"');
    expect(metrics.body).toMatch(
      /cursor_proxy_requests_total\{[^}]*route="\/v1\/chat\/completions"[^}]*\} [1-9]/,
    );
  });

  it("excludes dashboard and metrics traffic from the JSONL request log", async () => {
    const server = await start();
    const logPath = path.join(tmpDir, "requests.jsonl");

    await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await waitForJsonl(logPath, 1);

    await fetchServer(server, "/metrics");
    await fetchServer(server, "/api/status");
    await fetchServer(server, "/");

    // Give the finish handlers a tick; excluded routes must not append.
    await new Promise((r) => setTimeout(r, 50));

    const lines = fs
      .readFileSync(logPath, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const pathnames = lines.map(
      (line) => (JSON.parse(line) as { pathname: string }).pathname,
    );
    expect(pathnames).toContain("/v1/chat/completions");
    expect(pathnames).not.toContain("/metrics");
    expect(pathnames).not.toContain("/api/status");
    expect(pathnames).not.toContain("/");

    const metrics = await fetchServer(server, "/metrics");
    expect(metrics.body).not.toContain('route="/metrics"');
    expect(metrics.body).not.toContain('route="/api/status"');
  });
});
