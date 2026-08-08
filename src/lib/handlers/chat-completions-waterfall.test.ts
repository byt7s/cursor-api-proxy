import { EMPTY_CONFIG_FILE_STATE } from "../config-file.js";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../config.js";
import { startBridgeServer } from "../server.js";

const runAgentSync = vi.fn();
const runAgentStream = vi.fn();

vi.mock("../agent-runner.js", () => ({
  runAgentSync: (...args: unknown[]) => runAgentSync(...args),
  runAgentStream: (...args: unknown[]) => runAgentStream(...args),
}));

vi.mock("../cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../request-log.js", () => ({
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
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/cursor-proxy-waterfall-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
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
    defaultEngine: "acp",
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    thoughtMode: "drop",
    toolCalls: false,
    modelAliases: {},
    ignoreImages: false,
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    admissionWaitMs: 0,
    ...overrides,
  };
}

async function fetchServer(
  server: http.Server,
  path: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}${path}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: res.headers,
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("chat-completions latency waterfall header", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
    runAgentSync.mockReset();
    runAgentStream.mockReset();
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "ok",
      stderr: "",
    });
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
  });

  async function start(overrides: Partial<BridgeConfig> = {}): Promise<http.Server> {
    const started = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(overrides),
    });
    servers = started as http.Server[];
    await new Promise<void>((resolve) => servers[0]!.on("listening", () => resolve()));
    return servers[0]!;
  }

  it("sets X-Cursor-Proxy-Waterfall when latencyWaterfall is enabled", async () => {
    const server = await start({ latencyWaterfall: true });
    const res = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "default",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const header = res.headers["x-cursor-proxy-waterfall"];
    expect(typeof header).toBe("string");
    expect(String(header).length).toBeGreaterThan(0);
  });

  it("omits X-Cursor-Proxy-Waterfall when latencyWaterfall is disabled", async () => {
    const server = await start({ latencyWaterfall: false });
    const res = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "default",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers["x-cursor-proxy-waterfall"]).toBeUndefined();
  });
});
