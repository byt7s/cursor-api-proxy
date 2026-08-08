import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import type { BridgeConfig } from "./config.js";
import {
  publishDashboardEvent,
  resetDashboardEventBus,
} from "./event-bus.js";
import { startBridgeServer } from "./server.js";

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([]),
}));

vi.mock("./process.js", () => ({
  killAllChildProcesses: vi.fn(),
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

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
    modelAliases: {},
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
    auditLogEnabled: false,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    configFile: EMPTY_CONFIG_FILE_STATE,
    requestsLogPath: path.join(tmpDir, "requests.jsonl"),
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: false,
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
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    admissionWaitMs: 0,
    latencyWaterfall: false,
    thoughtMode: "drop",
    toolCalls: false,
    ...overrides,
  };
}

async function start(config: BridgeConfig): Promise<http.Server> {
  const servers = startBridgeServer({ version: "9.9.9", config }) as http.Server[];
  await new Promise<void>((resolve) => servers[0]!.on("listening", () => resolve()));
  return servers[0]!;
}

describe("GET /api/events", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-events-"));
    resetDashboardEventBus();
  });

  afterEach(() => {
    resetDashboardEventBus();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("requires sensitive-read auth when a dashboard key is set", async () => {
    const server = await start(
      createTestConfig({ dashboardKey: "dash-secret" }),
    );
    try {
      const addr = server.address() as { port: number };
      const denied = await fetch(`http://127.0.0.1:${addr.port}/api/events`);
      expect(denied.status).toBe(401);

      const ok = await fetch(`http://127.0.0.1:${addr.port}/api/events`, {
        headers: { Authorization: "Bearer dash-secret" },
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get("content-type")).toMatch(/text\/event-stream/);
      ok.body?.cancel();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("frames an initial status event and published bus events", async () => {
    const server = await start(createTestConfig());
    try {
      const addr = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${addr.port}/api/events`);
      expect(res.status).toBe(200);
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readUntil = async (needle: string) => {
        const deadline = Date.now() + 2000;
        while (!buffer.includes(needle) && Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
        }
      };

      await readUntil("event: status");
      expect(buffer).toContain("event: status");
      expect(buffer).toContain("data: {}");

      publishDashboardEvent({ type: "log", data: { line: "hello-sse" } });
      await readUntil("hello-sse");
      expect(buffer).toContain("event: log");
      expect(buffer).toContain("hello-sse");

      await reader.cancel();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
