import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { accountsDir } = vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const accountsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cap-accounts-http-"));
  return { accountsDir };
});

vi.mock("../../cli/constants.js", () => ({
  ACCOUNTS_DIR: accountsDir,
}));

import { writeApiKeyAccount } from "../account-api-key.js";
import type { BridgeConfig } from "../config.js";
import { startBridgeServer } from "../server.js";
import * as usage from "../../cli/usage.js";

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
    sessionsLogPath: path.join(os.tmpdir(), "cap-accounts-http.log"),
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
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

async function fetchServer(
  server: http.Server,
  urlPath: string,
  options: { headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string; json: unknown }> {
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}${urlPath}`;
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: "GET", headers: options.headers },
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
    req.end();
  });
}

describe("GET /accounts", () => {
  let servers: http.Server[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await new Promise((r) => s.close(r));
    }
    servers = [];
    vi.restoreAllMocks();
    fs.rmSync(accountsDir, { recursive: true, force: true });
    fs.mkdirSync(accountsDir, { recursive: true });
  });

  async function start(config: BridgeConfig): Promise<http.Server> {
    const started = startBridgeServer({ version: "1.0.0", config });
    servers = started as http.Server[];
    await new Promise<void>((resolve) => servers[0]!.on("listening", () => resolve()));
    return servers[0]!;
  }

  it("returns accounts report JSON without echoing api keys", async () => {
    writeApiKeyAccount(
      path.join(accountsDir, "http-acc"),
      "http-acc",
      "crsr_http_secret_key",
    );
    vi.spyOn(usage, "fetchApiKeyProfile").mockResolvedValue({
      apiKeyName: "proxy-key",
      createdAt: "2026-08-08T00:00:00.000Z",
      userEmail: "http@example.com",
    });

    const server = await start(createTestConfig());
    const res = await fetchServer(server, "/accounts");
    expect(res.status).toBe(200);
    const body = res.json as {
      accounts: Array<{
        name: string;
        authMethod: string | null;
        apiKeyName: string | null;
      }>;
    };
    expect(body.accounts.some((a) => a.name === "http-acc")).toBe(true);
    const acc = body.accounts.find((a) => a.name === "http-acc")!;
    expect(acc.authMethod).toBe("api-key");
    expect(acc.apiKeyName).toBe("proxy-key");
    expect(JSON.stringify(res.json)).not.toContain("crsr_http_secret_key");
  });

  it("requires bearer when requiredKey is set", async () => {
    const server = await start(createTestConfig({ requiredKey: "secret" }));
    const denied = await fetchServer(server, "/accounts");
    expect(denied.status).toBe(401);

    const ok = await fetchServer(server, "/accounts", {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ accounts: expect.any(Array) });
  });
});
