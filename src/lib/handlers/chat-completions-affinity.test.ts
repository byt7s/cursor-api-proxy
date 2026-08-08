import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "../config.js";
import { startBridgeServer } from "../server.js";
import {
  bindSessionAffinity,
  getSessionAffinity,
  resetSessionAffinityForTests,
} from "../session-affinity.js";
import { initAccountPool } from "../account-pool.js";

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
    sessionsLogPath: "/tmp/cursor-proxy-affinity-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    defaultEngine: "sdk",
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: ["/acc/a", "/acc/b"],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    admissionWaitMs: 0,
    latencyWaterfall: false,
    thoughtMode: "drop",
    toolCalls: false,
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
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
): Promise<{ status: number; body: string }> {
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
          }),
        );
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

describe("chat-completions session affinity wiring", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
    resetSessionAffinityForTests();
    initAccountPool(["/acc/a", "/acc/b"]);
    runAgentSync.mockReset();
    runAgentStream.mockReset();
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "hello",
      stderr: "",
      agentId: "agent_new",
    });
  });

  afterEach(async () => {
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
    initAccountPool([]);
    resetSessionAffinityForTests();
  });

  async function start(): Promise<http.Server> {
    const started = startBridgeServer({
      version: "1.0.0",
      config: createTestConfig(),
    });
    servers = started as http.Server[];
    await new Promise<void>((resolve) => servers[0]!.on("listening", () => resolve()));
    return servers[0]!;
  }

  it("passes resumeAgentId for sticky SDK conversations and rebinds agentId", async () => {
    bindSessionAffinity("conv-wire", {
      configDir: "/acc/a",
      agentId: "agent_sticky",
      engine: "sdk",
    });
    const server = await start();

    const { status, body } = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cursor-conversation-id": "conv-wire",
      },
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "follow up" }],
      }),
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).choices[0].message.content).toBe("hello");
    expect(runAgentSync).toHaveBeenCalled();
    const args = runAgentSync.mock.calls[0]!;
    // resumeAgentId is the last positional arg on runAgentSync
    expect(args[args.length - 1]).toBe("agent_sticky");
    // preferred account is first usable (affinity preferConfigDir)
    expect(args[6]).toBe("/acc/a");
    expect(getSessionAffinity("conv-wire")).toMatchObject({
      configDir: "/acc/a",
      agentId: "agent_new",
      engine: "sdk",
    });
  });

  it("clears affinity when failover callback fires after sdk_resume_failed", async () => {
    bindSessionAffinity("conv-fail", {
      configDir: "/acc/a",
      agentId: "agent_dead",
      engine: "sdk",
    });
    runAgentSync
      .mockResolvedValueOnce({
        code: 1,
        stdout: "",
        stderr: "sdk_resume_failed",
        failureText: "sdk_resume_failed",
      })
      .mockResolvedValueOnce({
        code: 0,
        stdout: "recovered",
        stderr: "",
        agentId: "agent_b",
      });

    const server = await start();
    const { status, body } = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-cursor-conversation-id": "conv-fail",
      },
      body: JSON.stringify({
        model: "composer-2.5",
        messages: [{ role: "user", content: "retry" }],
      }),
    });

    expect(status).toBe(200);
    expect(JSON.parse(body).choices[0].message.content).toBe("recovered");
    expect(runAgentSync).toHaveBeenCalledTimes(2);
    expect(getSessionAffinity("conv-fail")).toMatchObject({
      configDir: "/acc/b",
      agentId: "agent_b",
    });
  });
});
