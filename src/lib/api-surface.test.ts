import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import * as http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BridgeConfig } from "./config.js";
import { startBridgeServer } from "./server.js";

const runAgentSync = vi.fn();
const runAgentStream = vi.fn();

vi.mock("./agent-runner.js", () => ({
  runAgentSync: (...args: unknown[]) => runAgentSync(...args),
  runAgentStream: (...args: unknown[]) => runAgentStream(...args),
}));

vi.mock("./cursor-cli.js", () => ({
  listCursorCliModels: vi.fn().mockResolvedValue([]),
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
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/api-surface-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
    acpSkipAuthenticate: false,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: false,
    bridgePackageVersion: "0.0.0-test",
    toolCalls: true,
    ignoreImages: false,
    defaultEngine: "acp",
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    admissionWaitMs: 0,
    apiKeys: [],
    keyRateLimitPerMin: 0,
    auditLogPath: "/tmp/audit.jsonl",
    auditLogEnabled: false,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    configFile: EMPTY_CONFIG_FILE_STATE,
    requestsLogPath: "/tmp/requests.jsonl",
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: false,
    latencyWaterfall: false,
    thoughtMode: "drop",
    ...overrides,
  };
}

async function start(config: BridgeConfig): Promise<http.Server> {
  const servers = startBridgeServer({
    version: "9.9.9",
    config,
  }) as http.Server[];
  await new Promise<void>((resolve) =>
    servers[0]!.on("listening", () => resolve()),
  );
  return servers[0]!;
}

async function post(
  server: http.Server,
  pathName: string,
  body: unknown,
): Promise<{ status: number; json: any; headers: Headers }> {
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

async function postStream(
  server: http.Server,
  pathName: string,
  body: unknown,
): Promise<{ status: number; body: string }> {
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${pathName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.text() };
}

const lookupTool = {
  name: "lookup",
  description: "Lookup",
  input_schema: {
    type: "object",
    properties: { q: { type: "string" } },
  },
};

describe("API surface", () => {
  let server: http.Server;

  beforeEach(() => {
    runAgentSync.mockReset();
    runAgentStream.mockReset();
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns 501 embeddings_not_supported for /v1/embeddings", async () => {
    server = await start(createTestConfig());
    const res = await post(server, "/v1/embeddings", {
      model: "text-embedding-3-small",
      input: "hi",
    });
    expect(res.status).toBe(501);
    expect(res.json.error.code).toBe("embeddings_not_supported");
  });

  it("rejects image parts by default with images_not_supported", async () => {
    server = await start(createTestConfig());
    const res = await post(server, "/v1/chat/completions", {
      model: "composer-2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("images_not_supported");
    expect(runAgentSync).not.toHaveBeenCalled();
  });

  it("strips images and continues when ignoreImages is true", async () => {
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "ok text",
      stderr: "",
    });
    server = await start(createTestConfig({ ignoreImages: true }));
    const res = await post(server, "/v1/chat/completions", {
      model: "composer-2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.choices[0].message.content).toContain("ok text");
    expect(runAgentSync).toHaveBeenCalled();
  });

  it("shapes Anthropic tool_use when toolCalls is enabled", async () => {
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: '{"name":"lookup","arguments":{"q":"hi"}}',
      stderr: "",
    });
    server = await start(createTestConfig({ toolCalls: true }));
    const res = await post(server, "/v1/messages", {
      model: "composer-2",
      max_tokens: 64,
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          input_schema: {
            type: "object",
            properties: { q: { type: "string" } },
          },
        },
      ],
      messages: [{ role: "user", content: "find hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.stop_reason).toBe("tool_use");
    expect(res.json.content[0]).toMatchObject({
      type: "tool_use",
      name: "lookup",
      input: { q: "hi" },
    });
  });

  it("keeps text-only Anthropic responses unchanged without tools", async () => {
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "plain answer",
      stderr: "",
    });
    server = await start(createTestConfig({ toolCalls: true }));
    const res = await post(server, "/v1/messages", {
      model: "composer-2",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.stop_reason).toBe("end_turn");
    expect(res.json.content).toEqual([{ type: "text", text: "plain answer" }]);
  });

  it("rejects Anthropic image blocks on /v1/messages by default", async () => {
    server = await start(createTestConfig());
    const res = await post(server, "/v1/messages", {
      model: "composer-2",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aa",
              },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe("images_not_supported");
    expect(runAgentSync).not.toHaveBeenCalled();
  });

  it("strips Anthropic images on /v1/messages when ignoreImages is true", async () => {
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "no vision",
      stderr: "",
    });
    server = await start(createTestConfig({ ignoreImages: true }));
    const res = await post(server, "/v1/messages", {
      model: "composer-2",
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "aa",
              },
            },
          ],
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.json.content[0].text).toContain("no vision");
    expect(runAgentSync).toHaveBeenCalled();
  });

  it("rejects Responses input_image by default and strips when ignoreImages", async () => {
    server = await start(createTestConfig());
    const denied = await post(server, "/v1/responses", {
      model: "composer-2",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "describe" },
            { type: "input_image", image_url: "https://x/y.png" },
          ],
        },
      ],
    });
    expect(denied.status).toBe(400);
    expect(denied.json.error.code).toBe("images_not_supported");
    expect(runAgentSync).not.toHaveBeenCalled();

    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: "stripped ok",
      stderr: "",
    });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = await start(createTestConfig({ ignoreImages: true }));
    const addr = server.address() as { port: number };
    const okRes = await fetch(`http://127.0.0.1:${addr.port}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "composer-2",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "describe" },
              { type: "input_image", image_url: "https://x/y.png" },
            ],
          },
        ],
      }),
    });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get("x-cursor-proxy-images-ignored")).toBe("true");
    const okJson = (await okRes.json()) as {
      output_text?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    const text =
      okJson.output_text ??
      okJson.output?.[0]?.content?.[0]?.text ??
      "";
    expect(text).toContain("stripped ok");
    expect(runAgentSync).toHaveBeenCalled();
  });

  it("buffers Anthropic streaming tool_use when toolCalls is enabled", async () => {
    runAgentStream.mockImplementation(
      async (
        _cfg: unknown,
        _ws: unknown,
        _chat: unknown,
        _args: unknown,
        onChunk: (t: string) => void,
      ) => {
        onChunk('{"name":"lookup",');
        onChunk('"arguments":{"q":"streamed"}}');
        return { code: 0, stderr: "" };
      },
    );
    server = await start(
      createTestConfig({ toolCalls: true, useAcp: true }),
    );
    const res = await postStream(server, "/v1/messages", {
      model: "composer-2",
      max_tokens: 64,
      stream: true,
      tools: [lookupTool],
      messages: [{ role: "user", content: "find streamed" }],
    });
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('"text_delta"');
    expect(res.body).toContain('"type":"tool_use"');
    expect(res.body).toContain('"name":"lookup"');
    expect(res.body).toContain('"stop_reason":"tool_use"');
    expect(res.body).toContain('"type":"message_stop"');
  });

  it("keeps plain Anthropic text when tools are present but toolCalls is false", async () => {
    runAgentSync.mockResolvedValue({
      code: 0,
      stdout: '{"name":"lookup","arguments":{"q":"hi"}}',
      stderr: "",
    });
    server = await start(createTestConfig({ toolCalls: false }));
    const res = await post(server, "/v1/messages", {
      model: "composer-2",
      max_tokens: 64,
      tools: [lookupTool],
      messages: [{ role: "user", content: "find hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.json.stop_reason).toBe("end_turn");
    expect(res.json.content).toEqual([
      {
        type: "text",
        text: '{"name":"lookup","arguments":{"q":"hi"}}',
      },
    ]);
    expect(JSON.stringify(res.json)).not.toContain('"tool_use"');
  });
});
