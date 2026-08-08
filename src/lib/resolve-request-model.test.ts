import { describe, expect, it } from "vitest";

import { EMPTY_CONFIG_FILE_STATE } from "./config-file.js";
import type { BridgeConfig } from "./config.js";
import { resolveRequestModel } from "./resolve-request-model.js";

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agentBin: "agent",
    acpCommand: "agent",
    acpArgs: ["acp"],
    acpEnv: {},
    host: "127.0.0.1",
    port: 8765,
    defaultModel: "auto",
    modelAliases: {},
    mode: "ask",
    force: false,
    approveMcps: false,
    strictModel: true,
    workspace: process.cwd(),
    timeoutMs: 30_000,
    sessionsLogPath: "/tmp/sessions.log",
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
    contextPreamble: true,
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

describe("resolveRequestModel", () => {
  it("applies aliases before the Anthropic map", () => {
    const ref: { current?: string } = {};
    const result = resolveRequestModel(
      "gpt-4o",
      ref,
      config({ modelAliases: { "gpt-4o": "composer-2" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursorModel).toBe("composer-2");
    expect(result.displayModel).toBe("gpt-4o");
  });

  it("still maps Anthropic ids when no alias matches", () => {
    const ref: { current?: string } = {};
    const result = resolveRequestModel("claude-sonnet-4-5", ref, config());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursorModel).toBe("sonnet-4.5");
  });

  it("returns 400 for an empty alias target", () => {
    const result = resolveRequestModel(
      "bad",
      {},
      config({ modelAliases: { bad: "" } }),
    );
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: {
        error: { code: "invalid_model_alias", alias: "bad" },
      },
    });
  });

  it("strips provider prefixes before alias lookup", () => {
    const result = resolveRequestModel(
      "openai/gpt-4o",
      {},
      config({ modelAliases: { "gpt-4o": "composer-2" } }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cursorModel).toBe("composer-2");
  });
});
