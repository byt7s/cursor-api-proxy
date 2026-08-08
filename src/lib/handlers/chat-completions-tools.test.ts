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

const tools = [
  {
    type: "function",
    function: {
      name: "search_messages",
      description: "Search messages",
      parameters: {
        type: "object",
        properties: { keyword: { type: "string" } },
        required: ["keyword"],
      },
    },
  },
];

const toolJson =
  '{"name":"search_messages","arguments":{"keyword":"hello"}}';

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
    sessionsLogPath: "/tmp/cursor-proxy-tools-test.log",
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
    toolCalls: true,
    defaultEngine: "acp",
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    requestsLogPath: "/tmp/cursor-api-proxy-test-requests.jsonl",
    apiKeys: [],
    keyRateLimitPerMin: 0,
    auditLogPath: "/tmp/cursor-api-proxy-test-audit.jsonl",
    auditLogEnabled: false,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: true,
    latencyWaterfall: false,
    thoughtMode: "drop",
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

describe("chat-completions tool bridge", () => {
  let servers: http.Server[] = [];

  beforeEach(() => {
    runAgentSync.mockReset();
    runAgentStream.mockReset();
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: toolJson,
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

  it("returns tool_calls finish_reason when toolCalls is enabled", async () => {
    const server = await start();
    const { status, body } = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "default",
        tools,
        messages: [{ role: "user", content: "search hello" }],
      }),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].finish_reason).toBe("tool_calls");
    expect(data.choices[0].message.content).toBeNull();
    expect(data.choices[0].message.tool_calls[0].function.name).toBe(
      "search_messages",
    );
    expect(
      JSON.parse(data.choices[0].message.tool_calls[0].function.arguments),
    ).toEqual({ keyword: "hello" });
  });

  it("does not activate the bridge when tool_choice is none", async () => {
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "plain text reply",
      stderr: "",
    });
    const server = await start();
    const { status, body } = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "default",
        tools,
        tool_choice: "none",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body);
    expect(data.choices[0].finish_reason).toBe("stop");
    expect(data.choices[0].message.content).toBe("plain text reply");
    expect(data.choices[0].message.tool_calls).toBeUndefined();
  });

  it("buffers stream output and emits tool_calls at the end", async () => {
    runAgentStream.mockImplementation(
      async (
        _cfg: unknown,
        _ws: unknown,
        _chat: unknown,
        _args: unknown,
        onChunk: (t: string) => void,
      ) => {
        onChunk('{"name":"search_messages",');
        onChunk('"arguments":{"keyword":"streamed"}}');
        return { code: 0, stderr: "" };
      },
    );
    const server = await start();
    const { status, body } = await fetchServer(server, "/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "default",
        stream: true,
        tools,
        messages: [{ role: "user", content: "search" }],
      }),
    });
    expect(status).toBe(200);
    // Buffered: no partial content deltas with tool JSON fragments.
    expect(body).not.toContain('"content":"{\\"name\\""');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).toContain("search_messages");
    expect(body).toContain("data: [DONE]");
  });
});
