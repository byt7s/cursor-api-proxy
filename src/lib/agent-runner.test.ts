import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import { runAgentSync, runAgentStream } from "./agent-runner.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import { writeAccountApiKey, writeApiKeyAccount } from "./account-api-key.js";
import { shutdownAcpWarmPool } from "./acp-pool.js";
import {
  admitAgentRun,
  configureAdmission,
  resetAdmissionForTests,
} from "./admission.js";
import { writeAccountEngine } from "./execution-engine.js";
import { runSdkAgent } from "./sdk-executor.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";

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
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    admissionWaitMs: 0,
    latencyWaterfall: true,
    thoughtMode: "drop",
    toolCalls: false,
    ...overrides,
  };
}

describe("ACP requestTimeoutMs", () => {
  beforeEach(() => {
    shutdownAcpWarmPool();
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

describe("dual-cred session token refresh", () => {
  let tmp: string;
  const sessionJwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiJ1In0.sig";

  afterEach(() => {
    vi.mocked(readKeychainToken).mockReturnValue(undefined);
    vi.mocked(writeCachedToken).mockClear();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("refreshes cached JWT for dual-cred session+api-key accounts", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dual-refresh-"));
    const configDir = path.join(tmp, "work");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "cli-config.json"),
      JSON.stringify({
        authMethod: "cli",
        authInfo: { email: "work@example.com", authId: "auth0|1" },
      }),
    );
    writeAccountApiKey(configDir, "crsr_dual");
    vi.mocked(readKeychainToken).mockReturnValue(sessionJwt);

    await runAgentSync(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask"],
      undefined,
      "hello",
      configDir,
    );

    expect(writeCachedToken).toHaveBeenCalledWith(configDir, sessionJwt);
  });

  it("does not overwrite key-only account token with keychain JWT", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keyonly-"));
    const configDir = path.join(tmp, "keyacc");
    writeApiKeyAccount(configDir, "keyacc", "crsr_only");
    // writeApiKeyAccount may touch the token helper; only assert runner behavior.
    vi.mocked(writeCachedToken).mockClear();
    vi.mocked(readKeychainToken).mockReturnValue(sessionJwt);

    await runAgentSync(
      config(),
      "/tmp/ws",
      true,
      ["--print", "--mode", "ask"],
      undefined,
      "hello",
      configDir,
    );

    expect(writeCachedToken).not.toHaveBeenCalled();
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

  it("admits SDK runs on the separate higher-capacity plane", async () => {
    resetAdmissionForTests();
    configureAdmission({
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerAccount: 1,
      sdkMaxConcurrentRuns: 2,
      sdkMaxConcurrentRunsPerAccount: 2,
      waitMs: 0,
    });
    const acpHold = await admitAgentRun("/busy-acp", {
      plane: "acp",
      waitMs: 0,
    });
    expect(acpHold.ok).toBe(true);

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-plane-"));
    writeAccountApiKey(tmp, "crsr_plane");
    writeAccountEngine(tmp, "sdk");

    const result = await runAgentSync(
      config({ useAcp: true, admissionWaitMs: 0 }),
      "/tmp/ws",
      true,
      ["--print", "--model", "composer-2.5"],
      undefined,
      "via sdk plane",
      tmp,
    );
    expect(result.stdout).toBe("sdk-ok");
    expect(runSdkAgent).toHaveBeenCalled();

    if (acpHold.ok) acpHold.release();
    resetAdmissionForTests();
  });
});
