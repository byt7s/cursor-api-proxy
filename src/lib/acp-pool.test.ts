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
    defaultEngine: "acp",
    acpSkipAuthenticate: true,
    acpRawDebug: false,
    configDirs: ["/acct-a", "/acct-b"],
    multiPort: false,
    winCmdlineMax: 30_000,
    contextPreamble: true,
    bridgePackageVersion: "0.0.0-test",
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
    sdkMaxConcurrentRuns: 48,
    sdkMaxConcurrentRunsPerAccount: 12,
    admissionWaitMs: 0,
    requestsLogPath: "/tmp/cursor-api-proxy-test-requests.jsonl",
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: true,
    latencyWaterfall: true,
    thoughtMode: "drop",
    toolCalls: false,
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

  it("warms a single default worker when configDirs is empty", async () => {
    const pool = initAcpWarmPool(testConfig({ configDirs: [] }));
    await pool.start();
    expect(pool.getWorkerCount()).toBe(1);
    const result = await pool.runSync({
      configDir: undefined,
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "default-worker",
      mode: "ask",
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Hello from fake ACP");
  });

  it("reuses a warm worker across runStream prompts", async () => {
    const pool = initAcpWarmPool(
      testConfig({ configDirs: ["/acct-stream"], acpEnv: { FAKE_ACP_LABEL: "stream" } }),
    );
    await pool.start();
    expect(pool.getWorkerCount()).toBe(1);

    const chunks1: string[] = [];
    const chunks2: string[] = [];
    const r1 = await pool.runStream(
      {
        configDir: "/acct-stream",
        workspaceDir: cwd,
        effectiveChatOnly: true,
        prompt: "one",
        mode: "ask",
      },
      (t) => chunks1.push(t),
    );
    const r2 = await pool.runStream(
      {
        configDir: "/acct-stream",
        workspaceDir: cwd,
        effectiveChatOnly: true,
        prompt: "two",
        mode: "ask",
      },
      (t) => chunks2.push(t),
    );
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(chunks1.join("")).toContain("Hello from fake ACP");
    expect(chunks2.join("")).toContain("Hello from fake ACP");
    expect(pool.getWorkerCount()).toBe(1);
  });

  it("respawns after a warm worker exits mid-lifecycle", async () => {
    const pool = initAcpWarmPool(
      testConfig({
        configDirs: ["/acct-crash"],
        acpEnv: {
          FAKE_ACP_LABEL: "crash",
          FAKE_ACP_EXIT_AFTER_PROMPT: "1",
        },
      }),
    );
    await pool.start();
    expect(pool.getWorkerCount()).toBe(1);

    const first = await pool.runSync({
      configDir: "/acct-crash",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "bye",
      mode: "ask",
    });
    expect(first.code).toBe(0);

    // Give the child close event time to mark the worker dead, then respawn.
    await new Promise((r) => setTimeout(r, 100));
    await pool.respawnIfMissing("/acct-crash");
    expect(pool.getWorkerCount()).toBeGreaterThanOrEqual(1);

    // Next prompt still works (warm or temp overflow after another exit).
    const second = await pool.runSync({
      configDir: "/acct-crash",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "again",
      mode: "ask",
    });
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("Hello from fake ACP");
  });

  it("shutdown during an in-flight run does not hang", async () => {
    const pool = new AcpWarmPool(
      testConfig({
        configDirs: ["/acct-shut"],
        acpEnv: { FAKE_ACP_LABEL: "shut", FAKE_ACP_DELAY_MS: "300" },
      }),
    );
    await pool.start();
    const pending = pool.runSync({
      configDir: "/acct-shut",
      workspaceDir: cwd,
      effectiveChatOnly: true,
      prompt: "slow",
      mode: "ask",
    });
    await new Promise((r) => setTimeout(r, 30));
    pool.shutdown();
    expect(pool.getWorkerCount()).toBe(0);
    // In-flight RPC should settle (success or failure) without hanging the suite.
    await Promise.race([
      pending.catch(() => undefined),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
  });
});
