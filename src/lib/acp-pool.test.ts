import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AcpWorkerBusyError,
  AcpWarmPool,
  initAcpWarmPool,
  shutdownAcpWarmPool,
} from "./acp-pool.js";
import type { BridgeConfig } from "./config.js";

const node = process.execPath;
const cwd = process.cwd();
const fakeServerPath = join(cwd, "src", "lib", "__tests__", "fake-acp-server.mjs");

function testConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: node,
    acpArgs: [fakeServerPath],
    acpEnv: { FAKE_ACP_LABEL: "warm" },
    host: "127.0.0.1",
    port: 0,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: cwd,
    timeoutMs: 15_000,
    sessionsLogPath: "/tmp/acp-pool-test.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: true,
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: ["/acct-a", "/acct-b"],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    ...overrides,
  };
}

afterEach(() => {
  shutdownAcpWarmPool();
});

describe("AcpWarmPool", () => {
  it("warms one worker per account and reuses across prompts", async () => {
    const pool = initAcpWarmPool(testConfig());
    await pool.start();
    expect(pool.getWorkerCount()).toBe(2);

    const a1 = await pool.runSync({
      configDir: "/acct-a",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "one",
      mode: "ask",
    });
    const a2 = await pool.runSync({
      configDir: "/acct-a",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "two",
      mode: "ask",
    });
    expect(a1.code).toBe(0);
    expect(a2.code).toBe(0);
    expect(a1.stdout).toContain("Hello from fake ACP");
    expect(pool.getWorkerCount()).toBe(2);
  });

  it("throws busy when preferred worker is busy and another is idle", async () => {
    const pool = new AcpWarmPool(
      testConfig({
        acpEnv: { FAKE_ACP_LABEL: "a", FAKE_ACP_DELAY_MS: "200" },
        configDirs: ["/acct-a", "/acct-b"],
      }),
    );
    // Rebuild second worker with different env via start after manual... 
    // Use init with delay on all, acquire A, then sync on A should throw if B idle.
    // Both get same delay env — B still idle while A holds.
    await pool.start();

    const slow = pool.runSync({
      configDir: "/acct-a",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "slow",
      mode: "ask",
    });

    // Give the slow prompt time to acquire the worker
    await new Promise((r) => setTimeout(r, 30));

    await expect(
      pool.runSync({
        configDir: "/acct-a",
        workspaceDir: cwd,
        effectiveChatOnly: true,
        prompt: "other",
        mode: "ask",
      }),
    ).rejects.toBeInstanceOf(AcpWorkerBusyError);

    await slow;
    pool.shutdown();
  });

  it("spawns a temporary process when every warm worker is busy", async () => {
    const pool = new AcpWarmPool(
      testConfig({
        acpEnv: { FAKE_ACP_LABEL: "busy", FAKE_ACP_DELAY_MS: "150" },
        configDirs: ["/only"],
      }),
    );
    await pool.start();
    expect(pool.getWorkerCount()).toBe(1);

    const first = pool.runSync({
      configDir: "/only",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "hold",
      mode: "ask",
    });
    await new Promise((r) => setTimeout(r, 30));

    const overflow = await pool.runSync({
      configDir: "/only",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "overflow",
      mode: "ask",
    });
    expect(overflow.code).toBe(0);
    expect(overflow.stdout).toContain("Hello from fake ACP");

    await first;
    pool.shutdown();
  });
});
