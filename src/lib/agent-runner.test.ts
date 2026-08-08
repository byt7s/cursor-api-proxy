import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import { runAgentSync, runAgentStream } from "./agent-runner.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import { writeAccountApiKey } from "./account-api-key.js";
import { writeAccountEngine } from "./execution-engine.js";
import { runSdkAgent } from "./sdk-executor.js";

vi.mock("./acp-client.js", () => ({
  runAcpSync: vi.fn().mockResolvedValue({ code: 0, stdout: "ok", stderr: "" }),
  runAcpStream: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./process.js", () => ({
  run: vi.fn().mockResolvedValue({ code: 0, stdout: "cli", stderr: "" }),
  runStreaming: vi.fn().mockResolvedValue({ code: 0, stderr: "" }),
}));

vi.mock("./token-cache.js", () => ({
  readKeychainToken: vi.fn().mockReturnValue(undefined),
  writeCachedToken: vi.fn(),
}));

vi.mock("./sdk-executor.js", () => ({
  runSdkAgent: vi.fn().mockResolvedValue({
    code: 0,
    stdout: "sdk-ok",
    stderr: "",
  }),
}));

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
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
    timeoutMs: 123_456,
    sessionsLogPath: "/tmp/agent-runner-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    defaultEngine: "acp",
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

describe("ACP requestTimeoutMs", () => {
  beforeEach(() => {
    vi.mocked(runAcpSync).mockClear();
    vi.mocked(runAcpStream).mockClear();
  });

  it("passes config.timeoutMs as ACP sync requestTimeoutMs", async () => {
    await runAgentSync(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      undefined,
      "hello",
    );
    expect(runAcpSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpSync).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });

  it("passes config.timeoutMs as ACP stream requestTimeoutMs", async () => {
    await runAgentStream(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask", "--model", "auto"],
      () => {},
      undefined,
      "hello",
    );
    expect(runAcpStream).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runAcpStream).mock.calls[0][3]).toMatchObject({
      timeoutMs: 123_456,
      requestTimeoutMs: 123_456,
    });
  });
});

describe("SDK engine path", () => {
  let tmp: string;

  afterEach(() => {
    vi.mocked(runSdkAgent).mockClear();
    vi.mocked(runAcpSync).mockClear();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("uses SDK when per-account engine is sdk and API key exists", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-engine-"));
    writeAccountApiKey(tmp, "crsr_test_key");
    writeAccountEngine(tmp, "sdk");

    const result = await runAgentSync(
      config({ useAcp: true }),
      "/tmp/ws",
      true,
      ["--print", "--model", "composer-2.5"],
      undefined,
      "hello from sdk",
      tmp,
    );

    expect(result.stdout).toBe("sdk-ok");
    expect(runSdkAgent).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runSdkAgent).mock.calls[0]![0]).toMatchObject({
      prompt: "hello from sdk",
      apiKey: "crsr_test_key",
      cursorModel: "composer-2.5",
      cwd: "/tmp/ws",
    });
    expect(runAcpSync).not.toHaveBeenCalled();
  });

  it("fails clearly when sdk engine has no API key", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-nokey-"));
    writeAccountEngine(tmp, "sdk");

    const result = await runAgentSync(
      config({ defaultEngine: "acp" }),
      "/tmp/ws",
      true,
      ["--print"],
      undefined,
      "hello",
      tmp,
    );

    expect(result).toMatchObject({
      code: 1,
      failureText: "sdk_engine_requires_api_key",
    });
    expect(runSdkAgent).not.toHaveBeenCalled();
    expect(runAcpSync).not.toHaveBeenCalled();
  });

  it("keeps ACP when default engine is acp", async () => {
    await runAgentSync(
      config({ defaultEngine: "acp" }),
      "/tmp/ws",
      true,
      ["--print"],
      undefined,
      "hello",
    );
    expect(runAcpSync).toHaveBeenCalled();
    expect(runSdkAgent).not.toHaveBeenCalled();
  });
});
