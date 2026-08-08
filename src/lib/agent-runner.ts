import * as fs from "node:fs";

import {
  getAccountApiKeyEnv,
  hasAccountSessionAuth,
  readAccountApiKey,
  withAccountApiKeyArgs,
} from "./account-api-key.js";
import {
  accountKeyFor,
  AdmissionCapacityError,
  admitAgentRun,
} from "./admission.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import { getAcpWarmPool } from "./acp-pool.js";
import type { BridgeConfig } from "./config.js";
import { resolveAccountEngine } from "./execution-engine.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "./process.js";
import { runSdkAgent } from "./sdk-executor.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";

async function withAdmission<T>(
  config: BridgeConfig,
  configDir: string | undefined,
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const engine = resolveAccountEngine(configDir, config.defaultEngine);
  const admit = await admitAgentRun(accountKeyFor(configDir), {
    signal,
    waitMs: config.admissionWaitMs,
    plane: engine,
  });
  if (!admit.ok) {
    if (admit.reason === "aborted") {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    throw new AdmissionCapacityError(admit.retryAfterMs);
  }
  try {
    return await run();
  } finally {
    admit.release();
  }
}

/** Session JWTs are 3-part; agent API keys are `crsr_…` (see usage.ts). */
function isSessionJwt(token: string): boolean {
  if (!token || token.startsWith("crsr_")) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts[0]!.length > 0 && parts[1]!.length > 0;
}

function cacheTokenForAccount(configDir?: string): void {
  if (!configDir) return;
  const token = readKeychainToken();
  if (!token || !isSessionJwt(token)) return;
  // Key-only accounts keep the API key in `.cursor-token`; don't replace it
  // with an unrelated Keychain JWT. Dual-cred session accounts still refresh.
  if (readAccountApiKey(configDir) && !hasAccountSessionAuth(configDir)) return;
  writeCachedToken(configDir, token);
}

function applyAccountApiKeyToAcp(
  acpEnv: Record<string, string | undefined>,
  configDir?: string,
): boolean {
  const keyEnv = getAccountApiKeyEnv(configDir);
  if (!keyEnv) return false;
  Object.assign(acpEnv, keyEnv);
  return true;
}

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Thought channel text (route decides drop vs reasoning_content). */
  reasoning?: string;
  /** Stable failure token for quarantine / failover classifiers. */
  failureText?: string;
  /** SDK agent id for sticky `Agent.resume` on follow-ups. */
  agentId?: string;
};

function acpArgsWithModel(acpArgs: string[], model: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--model", model, ...acpArgs.slice(i + 1)];
}

function acpArgsWithMode(acpArgs: string[], mode: CursorExecutionMode): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  // cursor-agent only accepts --mode plan|ask; agent mode is the default.
  if (mode === "agent") return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--mode", mode, ...acpArgs.slice(i + 1)];
}

function acpArgsWithWorkspace(acpArgs: string[], workspaceDir: string): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  return [...acpArgs.slice(0, i), "--workspace", workspaceDir, ...acpArgs.slice(i)];
}

function extractModelFromCmdArgs(cmdArgs: string[]): string | undefined {
  const i = cmdArgs.indexOf("--model");
  return i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
}

function extractModeFromCmdArgs(cmdArgs: string[]): CursorExecutionMode {
  const i = cmdArgs.indexOf("--mode");
  const m =
    i >= 0 && i + 1 < cmdArgs.length ? cmdArgs[i + 1] : undefined;
  if (m === "agent" || m === "ask" || m === "plan") return m;
  return "ask";
}

function cleanupTemp(tempDir?: string): void {
  if (!tempDir) return;
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function resolveSdkApiKey(
  config: BridgeConfig,
  configDir?: string,
): string | undefined {
  return readAccountApiKey(configDir) ?? config.cursorApiKey;
}

/**
 * Run via `@cursor/sdk` when the account (or default) engine is `sdk`.
 * Returns null when ACP/CLI should handle the request instead.
 */
function trySdkRun(
  config: BridgeConfig,
  workspaceDir: string,
  cmdArgs: string[],
  stdinPrompt: string | undefined,
  configDir: string | undefined,
  signal: AbortSignal | undefined,
  onChunk?: (text: string) => void,
  onThought?: (text: string) => void,
  resumeAgentId?: string,
): Promise<AgentRunResult> | null {
  if (resolveAccountEngine(configDir, config.defaultEngine) !== "sdk") {
    return null;
  }
  const apiKey = resolveSdkApiKey(config, configDir);
  if (!apiKey) {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "sdk_engine_requires_api_key",
      failureText: "sdk_engine_requires_api_key",
    });
  }
  if (typeof stdinPrompt !== "string") {
    return Promise.resolve({
      code: 1,
      stdout: "",
      stderr: "sdk_engine_requires_prompt",
      failureText: "sdk_engine_requires_prompt",
    });
  }
  return runSdkAgent({
    prompt: stdinPrompt,
    cursorModel: extractModelFromCmdArgs(cmdArgs) ?? config.defaultModel,
    cwd: workspaceDir,
    apiKey,
    timeoutMs: config.timeoutMs,
    signal,
    onChunk,
    onThought,
    resumeAgentId,
  });
}

export function runAgentSync(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  resumeAgentId?: string,
): Promise<AgentRunResult> {
  return withAdmission(config, configDir, signal, () =>
    runAgentSyncUnlocked(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      tempDir,
      stdinPrompt,
      configDir,
      signal,
      resumeAgentId,
    ),
  );
}

function runAgentSyncUnlocked(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  resumeAgentId?: string,
): Promise<AgentRunResult> {
  const sdkRun = trySdkRun(
    config,
    workspaceDir,
    cmdArgs,
    stdinPrompt,
    configDir,
    signal,
    undefined,
    undefined,
    resumeAgentId,
  );
  if (sdkRun) {
    return sdkRun.finally(() => cleanupTemp(tempDir));
  }

  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    const pool = getAcpWarmPool();
    if (pool) {
      return pool
        .runSync({
          configDir,
          workspaceDir,
          effectiveChatOnly,
          prompt: stdinPrompt,
          model: acpModel,
          mode: acpMode,
          signal,
        })
        .then((out) => {
          cacheTokenForAccount(configDir);
          cleanupTemp(tempDir);
          return out;
        });
    }

    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    args = withAccountApiKeyArgs(args, configDir);
    const acpEnv = { ...config.acpEnv };
    const hasAccountApiKey = applyAccountApiKeyToAcp(acpEnv, configDir);
    if (effectiveChatOnly) {
      Object.assign(
        acpEnv,
        getChatOnlyEnvOverrides(
          workspaceDir,
          // Don't point ACP at stub API-key account dirs (Keychain fallback).
          hasAccountApiKey ? undefined : configDir,
        ),
      );
    }
    if (hasAccountApiKey) {
      delete acpEnv.CURSOR_CONFIG_DIR;
    }
    return runAcpSync(config.acpCommand, args, stdinPrompt, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      env: acpEnv,
      model: acpModel,
      requestTimeoutMs: config.timeoutMs,
      spawnOptions: config.acpSpawnOptions,
      skipAuthenticate: config.acpSkipAuthenticate || hasAccountApiKey,
      rawDebug: config.acpRawDebug,
      signal,
    }).then((out) => {
      cacheTokenForAccount(configDir);
      cleanupTemp(tempDir);
      return out;
    });
  }
  const runEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(
        workspaceDir,
        readAccountApiKey(configDir) ? undefined : configDir,
      )
    : undefined;
  return run(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    stdinContent: stdinPrompt,
    envOverrides: runEnvOverrides,
    configDir,
    signal,
  }).then((out) => {
    cacheTokenForAccount(configDir);
    cleanupTemp(tempDir);
    return out;
  });
}

export type StreamLineHandler = (line: string) => void;

export function runAgentStream(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  onThought?: StreamLineHandler,
  resumeAgentId?: string,
): Promise<{ code: number; stderr: string; agentId?: string }> {
  return withAdmission(config, configDir, signal, () =>
    runAgentStreamUnlocked(
      config,
      workspaceDir,
      effectiveChatOnly,
      cmdArgs,
      onLine,
      tempDir,
      stdinPrompt,
      configDir,
      signal,
      onThought,
      resumeAgentId,
    ),
  );
}

function runAgentStreamUnlocked(
  config: BridgeConfig,
  workspaceDir: string,
  effectiveChatOnly: boolean,
  cmdArgs: string[],
  onLine: StreamLineHandler,
  tempDir?: string,
  stdinPrompt?: string,
  configDir?: string,
  signal?: AbortSignal,
  onThought?: StreamLineHandler,
  resumeAgentId?: string,
): Promise<{ code: number; stderr: string; agentId?: string }> {
  const sdkRun = trySdkRun(
    config,
    workspaceDir,
    cmdArgs,
    stdinPrompt,
    configDir,
    signal,
    onLine,
    onThought,
    resumeAgentId,
  );
  if (sdkRun) {
    return sdkRun
      .then((result) => ({
        code: result.code,
        stderr: result.stderr,
        agentId: result.agentId,
      }))
      .finally(() => cleanupTemp(tempDir));
  }

  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    const pool = getAcpWarmPool();
    if (pool) {
      return pool
        .runStream(
          {
            configDir,
            workspaceDir,
            effectiveChatOnly,
            prompt: stdinPrompt,
            model: acpModel,
            mode: acpMode,
            signal,
          },
          onLine,
          onThought,
        )
        .then((result) => {
          cacheTokenForAccount(configDir);
          cleanupTemp(tempDir);
          return result;
        });
    }

    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    args = withAccountApiKeyArgs(args, configDir);
    const acpEnv = { ...config.acpEnv };
    const hasAccountApiKey = applyAccountApiKeyToAcp(acpEnv, configDir);
    if (effectiveChatOnly) {
      Object.assign(
        acpEnv,
        getChatOnlyEnvOverrides(
          workspaceDir,
          hasAccountApiKey ? undefined : configDir,
        ),
      );
    }
    if (hasAccountApiKey) {
      delete acpEnv.CURSOR_CONFIG_DIR;
    }
    return runAcpStream(
      config.acpCommand,
      args,
      stdinPrompt,
      {
        cwd: workspaceDir,
        timeoutMs: config.timeoutMs,
        env: acpEnv,
        model: acpModel,
        requestTimeoutMs: config.timeoutMs,
        spawnOptions: config.acpSpawnOptions,
        skipAuthenticate: config.acpSkipAuthenticate || hasAccountApiKey,
        rawDebug: config.acpRawDebug,
        signal,
      },
      onLine,
      onThought,
    ).then((result) => {
      cacheTokenForAccount(configDir);
      cleanupTemp(tempDir);
      return result;
    });
  }
  const streamEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(
        workspaceDir,
        readAccountApiKey(configDir) ? undefined : configDir,
      )
    : undefined;
  return runStreaming(config.agentBin, cmdArgs, {
    cwd: workspaceDir,
    timeoutMs: config.timeoutMs,
    maxMode: config.maxMode,
    onLine,
    stdinContent: stdinPrompt,
    envOverrides: streamEnvOverrides,
    configDir,
    signal,
  }).then((result) => {
    cacheTokenForAccount(configDir);
    cleanupTemp(tempDir);
    return result;
  });
}
