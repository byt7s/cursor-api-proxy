import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

import type { BridgeConfig } from "./config.js";
import { runAgentSync, runAgentStream } from "./agent-runner.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import { writeAccountApiKey, writeApiKeyAccount } from "./account-api-key.js";
import { shutdownAcpWarmPool } from "./acp-pool.js";
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
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: [],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
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
