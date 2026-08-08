/**
 * HTTP coverage for model alias 400s, allowlist deny, and account models API auth.
 */

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import {
  MODELS_FILE,
  writeAccountAllowedModels,
} from "./account-models.js";
import type { BridgeConfig } from "./config.js";
import { initAccountPool } from "./account-pool.js";
import { startBridgeServer } from "./server.js";
import { run } from "./process.js";

const { accountsDir } = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  return {
    accountsDir: fs.mkdtempSync(path.join(os.tmpdir(), "model-routing-acc-")),
  };
});

vi.mock("../cli/constants.js", () => ({
  ACCOUNTS_DIR: accountsDir,
}));

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
    auditLogEnabled: true,
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

async function fetchServer(
  server: http.Server,
  urlPath: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  const res = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  return {
    status: res.status,
    json: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

describe("model routing HTTP", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-routing-"));
    for (const name of fs.readdirSync(accountsDir)) {
      fs.rmSync(path.join(accountsDir, name), { recursive: true, force: true });
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns 400 invalid_model_alias for an empty alias target", async () => {
    const server = await start(
      createTestConfig({
        modelAliases: { broken: "" },
      }),
    );
    try {
      const res = await fetchServer(server, "/v1/chat/completions", {
        method: "POST",
        body: {
          model: "broken",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({
        error: { code: "invalid_model_alias", alias: "broken" },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns 403 model_not_allowed_for_any_account when no account allows the model", async () => {
    const a = path.join(accountsDir, "a");
    const b = path.join(accountsDir, "b");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    writeAccountAllowedModels(a, ["composer-2"]);
    writeAccountAllowedModels(b, ["sonnet-4.6"]);
    initAccountPool([a, b]);

    const server = await start(createTestConfig({ configDirs: [a, b] }));
    try {
      const res = await fetchServer(server, "/v1/chat/completions", {
        method: "POST",
        body: {
          model: "opus-4.6",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        error: {
          code: "model_not_allowed_for_any_account",
          model: "opus-4.6",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("requires sensitive-read auth for GET /api/accounts/:name/models", async () => {
    const work = path.join(accountsDir, "work");
    fs.mkdirSync(work, { recursive: true });
    writeAccountAllowedModels(work, ["composer-2"]);

    const server = await start(
      createTestConfig({
        dashboardKey: "dash-secret",
        configDirs: [work],
      }),
    );
    try {
      const denied = await fetchServer(server, "/api/accounts/work/models");
      expect(denied.status).toBe(401);

      const ok = await fetchServer(server, "/api/accounts/work/models", {
        headers: { Authorization: "Bearer dash-secret" },
      });
      expect(ok.status).toBe(200);
      expect(ok.json).toMatchObject({
        name: "work",
        allowedModels: ["composer-2"],
        unrestricted: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PUT /api/accounts/:name/models updates the allowlist under mutate auth", async () => {
    const work = path.join(accountsDir, "work");
    fs.mkdirSync(work, { recursive: true });

    const server = await start(
      createTestConfig({
        dashboardKey: "dash-secret",
        configDirs: [work],
      }),
    );
    try {
      const res = await fetchServer(server, "/api/accounts/work/models", {
        method: "PUT",
        headers: { Authorization: "Bearer dash-secret" },
        body: { allowedModels: ["composer-2", "sonnet-4.6"] },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        ok: true,
        allowedModels: ["composer-2", "sonnet-4.6"],
        unrestricted: false,
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("resolves gpt-4o → composer-2 when the allowlist permits the target", async () => {
    const work = path.join(accountsDir, "work");
    fs.mkdirSync(work, { recursive: true });
    writeAccountAllowedModels(work, ["composer-2"]);
    initAccountPool([work]);
    vi.mocked(run).mockClear();

    const server = await start(
      createTestConfig({
        modelAliases: { "gpt-4o": "composer-2" },
        configDirs: [work],
      }),
    );
    try {
      const res = await fetchServer(server, "/v1/chat/completions", {
        method: "POST",
        body: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        choices: [{ message: { content: "Hello from agent" } }],
      });
      expect(run).toHaveBeenCalled();
      const args = vi.mocked(run).mock.calls[0]![1] as string[];
      expect(args.join(" ")).toContain("composer-2");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns 403 with the resolved model id when an alias target is not allowed", async () => {
    const work = path.join(accountsDir, "work");
    fs.mkdirSync(work, { recursive: true });
    writeAccountAllowedModels(work, ["sonnet-4.6"]);
    initAccountPool([work]);

    const server = await start(
      createTestConfig({
        modelAliases: { "gpt-4o": "composer-2" },
        configDirs: [work],
      }),
    );
    try {
      const res = await fetchServer(server, "/v1/chat/completions", {
        method: "POST",
        body: {
          model: "gpt-4o",
          messages: [{ role: "user", content: "hi" }],
        },
      });
      expect(res.status).toBe(403);
      expect(res.json).toMatchObject({
        error: {
          code: "model_not_allowed_for_any_account",
          model: "composer-2",
        },
      });
      expect(JSON.stringify(res.json)).not.toContain("gpt-4o");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns the same invalid-alias and not-allowed errors on /v1/messages and /v1/responses", async () => {
    const work = path.join(accountsDir, "work");
    fs.mkdirSync(work, { recursive: true });
    writeAccountAllowedModels(work, ["sonnet-4.6"]);
    initAccountPool([work]);

    const server = await start(
      createTestConfig({
        modelAliases: { broken: "", "gpt-4o": "composer-2" },
        configDirs: [work],
      }),
    );
    try {
      for (const route of ["/v1/messages", "/v1/responses"] as const) {
        const invalidBody =
          route === "/v1/messages"
            ? {
                model: "broken",
                max_tokens: 16,
                messages: [{ role: "user", content: "hi" }],
              }
            : {
                model: "broken",
                input: "hi",
              };
        const invalid = await fetchServer(server, route, {
          method: "POST",
          body: invalidBody,
        });
        expect(invalid.status).toBe(400);
        expect(invalid.json).toMatchObject({
          error: { code: "invalid_model_alias", alias: "broken" },
        });

        const deniedBody =
          route === "/v1/messages"
            ? {
                model: "gpt-4o",
                max_tokens: 16,
                messages: [{ role: "user", content: "hi" }],
              }
            : {
                model: "gpt-4o",
                input: "hi",
              };
        const denied = await fetchServer(server, route, {
          method: "POST",
          body: deniedBody,
        });
        expect(denied.status).toBe(403);
        expect(denied.json).toMatchObject({
          error: {
            code: "model_not_allowed_for_any_account",
            model: "composer-2",
          },
        });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("PUT allowedModels: [] clears the file and marks the account unrestricted", async () => {
    const work = path.join(accountsDir, "work");
    fs.mkdirSync(work, { recursive: true });
    writeAccountAllowedModels(work, ["composer-2"]);
    expect(fs.existsSync(path.join(work, MODELS_FILE))).toBe(true);

    const server = await start(
      createTestConfig({
        dashboardKey: "dash-secret",
        configDirs: [work],
      }),
    );
    try {
      const res = await fetchServer(server, "/api/accounts/work/models", {
        method: "PUT",
        headers: { Authorization: "Bearer dash-secret" },
        body: { allowedModels: [] },
      });
      expect(res.status).toBe(200);
      expect(res.json).toMatchObject({
        ok: true,
        allowedModels: [],
        unrestricted: true,
      });
      expect(fs.existsSync(path.join(work, MODELS_FILE))).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
