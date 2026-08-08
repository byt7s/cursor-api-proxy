import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import { describe, expect, it } from "vitest";

import type { BridgeConfig } from "./config.js";
import { resolveRequestMode } from "./resolve-mode.js";

function base(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "default",
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: "/w",
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/s.log",
    chatOnlyWorkspace: true,
    chatOnlyWorkspaceExplicit: false,
    verbose: false,
    maxMode: false,
    promptViaStdin: false,
    useAcp: false,
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
    requestsLogPath: "/tmp/cursor-api-proxy-test-requests.jsonl",
    apiKeys: [],
    keyRateLimitPerMin: 0,
    auditLogPath: "/tmp/cursor-api-proxy-test-audit.jsonl",
    auditLogEnabled: false,
    auditLogMaxBytes: 1_000_000,
    maxBodyBytes: 8 * 1024 * 1024,
    corsOrigins: [],
    configFile: EMPTY_CONFIG_FILE_STATE,
    requestsLogEnabled: false,
    requestsLogMaxBytes: 1_000_000,
    metricsEnabled: true,
    latencyWaterfall: true,
    thoughtMode: "drop",
    toolCalls: false,
    ignoreImages: false,
    ...overrides,
  };
}

describe("resolveRequestMode", () => {
  it("prefers body.mode over header and config", () => {
    expect(
      resolveRequestMode(base({ mode: "plan" }), "agent", "ask"),
    ).toBe("ask");
  });

  it("uses header when body absent", () => {
    expect(resolveRequestMode(base({ mode: "ask" }), "plan", undefined)).toBe(
      "plan",
    );
  });

  it("falls back to config.mode", () => {
    expect(
      resolveRequestMode(base({ mode: "agent" }), undefined, undefined),
    ).toBe("agent");
  });

  it("uses agent when tools are present and mode is unset", () => {
    expect(
      resolveRequestMode(base({ mode: "ask" }), undefined, undefined, {
        hasTools: true,
      }),
    ).toBe("agent");
  });

  it("does not override explicit mode when tools are present", () => {
    expect(
      resolveRequestMode(base({ mode: "ask" }), undefined, "plan", {
        hasTools: true,
      }),
    ).toBe("plan");
  });

  it("throws on invalid body.mode", () => {
    expect(() =>
      resolveRequestMode(base(), undefined, "nope"),
    ).toThrow(/invalid mode/);
  });

  it("throws when body.mode is not a string", () => {
    expect(() =>
      resolveRequestMode(base(), undefined, 1),
    ).toThrow(/must be a string/);
  });
});
