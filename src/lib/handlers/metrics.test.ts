import { EMPTY_CONFIG_FILE_STATE } from "../config-file.js";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../config.js";
import { startBridgeServer } from "../server.js";
import { authorizeMetrics } from "./metrics.js";

vi.mock("../cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("../process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
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
    sessionsLogPath: path.join(os.tmpdir(), "cap-metrics-http.log"),
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
    requestsLogPath: path.join(os.tmpdir(), "cap-metrics-requests.jsonl"),
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
    latencyWaterfall: false,
    thoughtMode: "drop",
    toolCalls: false,
    ignoreImages: false,
    ...overrides,
  };
}

function request(
  server: http.Server,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string; contentType?: string }> {
  const port = (server.address() as { port: number }).port;
  return new Promise((resolve, reject) => {
    const req = http.request(
      `http://127.0.0.1:${port}${urlPath}`,
      { method: "GET", headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: res.headers["content-type"],
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function fakeReq(options: {
  remoteAddress?: string;
  authorization?: string;
}): http.IncomingMessage {
  return {
    headers: options.authorization
      ? { authorization: options.authorization }
      : {},
    socket: { remoteAddress: options.remoteAddress ?? "127.0.0.1" },
  } as unknown as http.IncomingMessage;
}

describe("authorizeMetrics", () => {
  it("requires a matching bearer token when requiredKey is set", () => {
    const config = createTestConfig({ requiredKey: "metrics-secret" });

    const missing = authorizeMetrics(fakeReq({}), config);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(401);

    const wrong = authorizeMetrics(
      fakeReq({ authorization: "Bearer nope" }),
      config,
    );
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.status).toBe(401);

    // With the key, the scrape may come from anywhere.
    expect(
      authorizeMetrics(
        fakeReq({
          authorization: "Bearer metrics-secret",
          remoteAddress: "203.0.113.9",
        }),
        config,
      ).ok,
    ).toBe(true);
  });

  it("falls back to loopback-only when no key is configured", () => {
    const config = createTestConfig({ requiredKey: undefined });
    expect(authorizeMetrics(fakeReq({ remoteAddress: "::1" }), config).ok).toBe(
      true,
    );

    const remote = authorizeMetrics(
      fakeReq({ remoteAddress: "203.0.113.9" }),
      config,
    );
    expect(remote.ok).toBe(false);
    if (!remote.ok) {
      expect(remote.status).toBe(403);
      expect(remote.code).toBe("forbidden");
    }
  });

  it("reports 404 when metrics are disabled, even for an authorized scrape", () => {
    const config = createTestConfig({
      metricsEnabled: false,
      requiredKey: "metrics-secret",
    });
    const denied = authorizeMetrics(
      fakeReq({ authorization: "Bearer metrics-secret" }),
      config,
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(404);
      expect(denied.code).toBe("not_found");
    }
  });
});

describe("GET /metrics", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) await new Promise((r) => s.close(r));
    servers = [];
  });

  async function start(config: BridgeConfig): Promise<http.Server> {
    servers = startBridgeServer({ version: "9.9.9", config }) as http.Server[];
    await new Promise<void>((resolve) =>
      servers[0]!.on("listening", () => resolve()),
    );
    return servers[0]!;
  }

  it("serves the Prometheus exposition format on loopback", async () => {
    const server = await start(createTestConfig());
    const res = await request(server, "/metrics");

    expect(res.status).toBe(200);
    expect(res.contentType).toBe("text/plain; version=0.0.4; charset=utf-8");
    expect(res.body).toContain("# HELP cursor_proxy_build_info");
    expect(res.body).toContain("# TYPE cursor_proxy_build_info gauge");
    expect(res.body).toContain('cursor_proxy_build_info{version="9.9.9"');
    expect(res.body).toContain("cursor_proxy_admission_limit");
  });

  it("counts proxied requests but not the scrape itself", async () => {
    const server = await start(createTestConfig());
    await request(server, "/healthz");
    await request(server, "/healthz");

    const res = await request(server, "/metrics");
    const healthz = res.body
      .split("\n")
      .filter((line) => line.includes('route="/healthz"'));
    expect(healthz.some((line) => line.endsWith("} 2"))).toBe(true);
    expect(res.body).not.toContain('route="/metrics"');
  });

  it("requires a bearer token when an API key is configured", async () => {
    const server = await start(createTestConfig({ requiredKey: "metrics-secret" }));

    const denied = await request(server, "/metrics");
    expect(denied.status).toBe(401);
    expect(denied.body).not.toContain("cursor_proxy_build_info");

    const ok = await request(server, "/metrics", {
      authorization: "Bearer metrics-secret",
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain("cursor_proxy_build_info");
  });

  it("returns 404 when CURSOR_BRIDGE_METRICS_ENABLED is false", async () => {
    const server = await start(createTestConfig({ metricsEnabled: false }));
    const res = await request(server, "/metrics");
    expect(res.status).toBe(404);
    expect(res.contentType).toContain("application/json");
    expect(res.body).not.toContain("cursor_proxy_build_info");
  });
});
