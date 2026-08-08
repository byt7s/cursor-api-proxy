import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ApiKeyEntry } from "./api-keys.js";
import type { ConfigFileState } from "./config-file.js";
import type { ExecutionEngine } from "./execution-engine.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { loadEnvConfig, resolveAgentCommand, type EnvOptions } from "./env.js";

function readBridgePackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "../../package.json");
    const raw = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

export type { CursorExecutionMode } from "./execution-mode.js";

export type BridgeConfig = {
  agentBin: string;
  /** Resolved command for ACP (node + script on Windows when .cmd); avoids spawn EINVAL and DEP0190. */
  acpCommand: string;
  /** Args for ACP (e.g. [scriptPath, "acp"] or ["acp"]). */
  acpArgs: string[];
  /** Env to use when spawning ACP (e.g. CURSOR_INVOKED_AS). */
  acpEnv: Record<string, string | undefined>;
  host: string;
  port: number;
  /** Legacy single inbound key (`CURSOR_BRIDGE_API_KEY`). */
  requiredKey?: string;
  /** Dedicated dashboard key; when set it is the only way in besides admin keys. */
  dashboardKey?: string;
  /** Every inbound key with its scope (see `CURSOR_BRIDGE_API_KEYS`). */
  apiKeys: ApiKeyEntry[];
  /** Per-key requests-per-minute cap; 0 disables throttling. */
  keyRateLimitPerMin: number;
  /** JSONL audit log for dashboard mutations. */
  auditLogPath: string;
  auditLogEnabled: boolean;
  auditLogMaxBytes: number;
  /** Reject JSON bodies over this size with 413; 0 disables the check. */
  maxBodyBytes: number;
  /** Allowed browser origins; empty means no CORS headers are emitted. */
  corsOrigins: string[];
  /** Config-file layer: path, contents, warnings and per-key value sources. */
  configFile: ConfigFileState;
  defaultModel: string;
  mode: CursorExecutionMode;
  force: boolean;
  approveMcps: boolean;
  strictModel: boolean;
  workspace: string;
  timeoutMs: number;
  /** Path to TLS certificate file (e.g. Tailscale cert). When set with tlsKeyPath, server uses HTTPS. */
  tlsCertPath?: string;
  /** Path to TLS private key file. When set with tlsCertPath, server uses HTTPS. */
  tlsKeyPath?: string;
  /** Path to sessions log file; each request is appended as a line. Default: sessions.log in cwd. */
  sessionsLogPath: string;
  /** Structured JSONL request log path (see CURSOR_BRIDGE_REQUESTS_LOG). */
  requestsLogPath: string;
  /** When true (default), append one JSON record per request to requestsLogPath. */
  requestsLogEnabled: boolean;
  /** Rotate the JSONL log to `.1` past this size (0 disables rotation). */
  requestsLogMaxBytes: number;
  /** When true (default), expose GET /metrics in Prometheus text format. */
  metricsEnabled: boolean;
  /** When true (default), run CLI in an empty temp dir so it cannot read or write the real project. Pure chat only. */
  chatOnlyWorkspace: boolean;
  /** True when CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE was set in the environment (any value). */
  chatOnlyWorkspaceExplicit: boolean;
  /** When true, print full request/response content to stdout for each completion. */
  verbose: boolean;
  /** When true, enable Cursor Max Mode (larger context, more tool calls) via cli-config.json preflight. */
  maxMode: boolean;
  /** When true, pass the user prompt via stdin instead of argv (avoids Windows argv issues). */
  promptViaStdin: boolean;
  /** When true, use ACP (Agent Client Protocol) over stdio; fixes prompt delivery on Windows. */
  useAcp: boolean;
  /**
   * Default engine (`acp` | `sdk`) when an account has no `.cursor-bridge-engine`.
   * See `CURSOR_BRIDGE_DEFAULT_ENGINE`. SDK requires Node >= 22.13 + API key.
   */
  defaultEngine: ExecutionEngine;
  /** Process-wide Dashboard API key (`CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN`), if set. */
  cursorApiKey?: string;
  /** Spawn options for ACP (e.g. windowsVerbatimArguments when using cmd.exe fallback). */
  acpSpawnOptions?: { windowsVerbatimArguments?: boolean };
  /** When true, skip ACP authenticate step (use when pre-authenticated via --api-key or agent login). */
  acpSkipAuthenticate: boolean;
  /** When true, log every raw JSON-RPC line from ACP stdout (very verbose). Set CURSOR_BRIDGE_ACP_RAW_DEBUG=1 to enable. */
  acpRawDebug: boolean;
  /** Pool of cursor configuration directories for round-robin account rotation. */
  configDirs: string[];
  /** When true, runs each config dir on its own incrementing port starting from `port` */
  multiPort: boolean;
  /** Windows CreateProcess command-line budget for prompt truncation (ignored on non-Windows). */
  winCmdlineMax: number;
  /** Prepend bridge/workspace context to the agent prompt (see CURSOR_BRIDGE_CONTEXT_PREAMBLE). */
  contextPreamble: boolean;
  /** `version` field from this package’s package.json (shown in the bridge preamble). */
  bridgePackageVersion: string;
  /** Optional operator notes appended to the preamble (see CURSOR_BRIDGE_CONTEXT_EXTRA). */
  contextExtra?: string;
  /** Global cap on concurrent ACP/CLI agent runs. */
  maxConcurrentRuns: number;
  /** Per-account cap on concurrent ACP/CLI agent runs. */
  maxConcurrentRunsPerAccount: number;
  /** Global cap on concurrent in-process SDK agent runs. */
  sdkMaxConcurrentRuns: number;
  /** Per-account cap on concurrent SDK agent runs. */
  sdkMaxConcurrentRunsPerAccount: number;
  /** How long to wait for an admission permit before failing. */
  admissionWaitMs: number;
  /** Log compact per-request latency spans (see CURSOR_BRIDGE_LATENCY_WATERFALL). */
  latencyWaterfall: boolean;
  /**
   * Thought channel policy (CURSOR_BRIDGE_THOUGHT_MODE):
   * drop (default) or map to OpenAI reasoning_content.
   */
  thoughtMode: "drop" | "reasoning";
  /** Bridge textual tool output to OpenAI tool_calls / Anthropic tool_use. */
  toolCalls: boolean;
  /** Strip image parts instead of rejecting (CURSOR_BRIDGE_IGNORE_IMAGES). */
  ignoreImages: boolean;
};

export function loadBridgeConfig(opts: EnvOptions = {}): BridgeConfig {
  const env = loadEnvConfig(opts);
  const acpResolved = resolveAgentCommand(env.agentBin, ["acp"], opts);
  const envSource = opts.env ?? process.env;
  const apiKey = envSource.CURSOR_API_KEY ?? envSource.CURSOR_AUTH_TOKEN;
  const acpArgs = acpResolved.args;

  for (const warning of [...env.configFile.warnings, ...env.apiKeyWarnings]) {
    console.warn(`[config] ${warning}`);
  }

  const acpEnv = { ...acpResolved.env } as Record<string, string | undefined>;
  if (apiKey) {
    acpEnv.CURSOR_API_KEY = apiKey;
    acpEnv.CURSOR_AUTH_TOKEN = apiKey;
  }

  return {
    agentBin: env.agentBin,
    acpCommand: acpResolved.command,
    acpArgs,
    acpEnv,
    host: env.host,
    port: env.port,
    requiredKey: env.requiredKey,
    dashboardKey: env.dashboardKey,
    apiKeys: env.apiKeys,
    keyRateLimitPerMin: env.keyRateLimitPerMin,
    auditLogPath: env.auditLogPath,
    auditLogEnabled: env.auditLogEnabled,
    auditLogMaxBytes: env.auditLogMaxBytes,
    maxBodyBytes: env.maxBodyBytes,
    corsOrigins: env.corsOrigins,
    configFile: env.configFile,
    defaultModel: env.defaultModel,
    mode: env.mode ?? opts.mode ?? "ask",
    force: env.force,
    approveMcps: env.approveMcps,
    strictModel: env.strictModel,
    workspace: env.workspace,
    timeoutMs: env.timeoutMs,
    tlsCertPath: env.tlsCertPath,
    tlsKeyPath: env.tlsKeyPath,
    sessionsLogPath: env.sessionsLogPath,
    requestsLogPath: env.requestsLogPath,
    requestsLogEnabled: env.requestsLogEnabled,
    requestsLogMaxBytes: env.requestsLogMaxBytes,
    metricsEnabled: env.metricsEnabled,
    chatOnlyWorkspace: env.chatOnlyWorkspace,
    chatOnlyWorkspaceExplicit: env.chatOnlyWorkspaceExplicit,
    verbose: env.verbose,
    maxMode: env.maxMode,
    promptViaStdin: env.promptViaStdin,
    useAcp: env.useAcp,
    defaultEngine: env.defaultEngine,
    cursorApiKey: apiKey || undefined,
    acpSpawnOptions:
      acpResolved.windowsVerbatimArguments != null
        ? { windowsVerbatimArguments: acpResolved.windowsVerbatimArguments }
        : undefined,
    acpSkipAuthenticate:
      !!apiKey ||
      /^(1|true|yes|on)$/i.test(
        String(envSource.CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE ?? "").trim(),
      ),
    acpRawDebug: /^(1|true|yes|on)$/i.test(
      String(envSource.CURSOR_BRIDGE_ACP_RAW_DEBUG ?? "").trim(),
    ),
    configDirs: env.configDirs ?? [],
    multiPort: env.multiPort,
    winCmdlineMax: env.winCmdlineMax,
    contextPreamble: env.contextPreamble,
    bridgePackageVersion: readBridgePackageVersion(),
    contextExtra: env.contextExtra,
    maxConcurrentRuns: env.maxConcurrentRuns,
    maxConcurrentRunsPerAccount: env.maxConcurrentRunsPerAccount,
    sdkMaxConcurrentRuns: env.sdkMaxConcurrentRuns,
    sdkMaxConcurrentRunsPerAccount: env.sdkMaxConcurrentRunsPerAccount,
    admissionWaitMs: env.admissionWaitMs,
    latencyWaterfall: env.latencyWaterfall,
    thoughtMode: env.thoughtMode,
    toolCalls: env.toolCalls,
    ignoreImages: env.ignoreImages,
  };
}
