import * as fs from "node:fs";

import {
  hasAccountSessionAuth,
  readAccountApiKey,
} from "./account-api-key.js";
import { runAcpStream, runAcpSync } from "./acp-client.js";
import type { BridgeConfig } from "./config.js";
import { resolveAccountEngine } from "./execution-engine.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { run, runStreaming } from "./process.js";
import { runSdkAgent } from "./sdk-executor.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";
import { readKeychainToken, writeCachedToken } from "./token-cache.js";

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

export type AgentRunResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Thought channel text (when thoughtMode=reasoning). */
  reasoning?: string;
  /** Stable failure token for quarantine / failover classifiers. */
  failureText?: string;
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
): Promise<AgentRunResult> {
  const sdkRun = trySdkRun(
    config,
    workspaceDir,
    cmdArgs,
    stdinPrompt,
    configDir,
    signal,
  );
  if (sdkRun) {
    return sdkRun.finally(() => cleanupTemp(tempDir));
  }

  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    const acpEnv = { ...config.acpEnv };
    if (effectiveChatOnly) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
    }
    return runAcpSync(config.acpCommand, args, stdinPrompt, {
      cwd: workspaceDir,
      timeoutMs: config.timeoutMs,
      env: acpEnv,
      model: acpModel,
      requestTimeoutMs: config.timeoutMs,
      spawnOptions: config.acpSpawnOptions,
      skipAuthenticate: config.acpSkipAuthenticate,
      rawDebug: config.acpRawDebug,
      signal,
    }).then((out) => {
      cacheTokenForAccount(configDir);
      cleanupTemp(tempDir);
      return out;
    });
  }
  const runEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
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
): Promise<{ code: number; stderr: string }> {
  const sdkRun = trySdkRun(
    config,
    workspaceDir,
    cmdArgs,
    stdinPrompt,
    configDir,
    signal,
    onLine,
    onThought,
  );
  if (sdkRun) {
    return sdkRun
      .then((result) => ({ code: result.code, stderr: result.stderr }))
      .finally(() => cleanupTemp(tempDir));
  }

  if (config.useAcp && typeof stdinPrompt === "string") {
    const acpModel = extractModelFromCmdArgs(cmdArgs);
    const acpMode = extractModeFromCmdArgs(cmdArgs);
    let args = acpArgsWithWorkspace(config.acpArgs, workspaceDir);
    args = acpModel ? acpArgsWithModel(args, acpModel) : args;
    args = acpArgsWithMode(args, acpMode);
    const acpEnv = { ...config.acpEnv };
    if (effectiveChatOnly) {
      Object.assign(acpEnv, getChatOnlyEnvOverrides(workspaceDir, configDir));
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
        skipAuthenticate: config.acpSkipAuthenticate,
        rawDebug: config.acpRawDebug,
        signal,
      },
      onLine,
    ).then((result) => {
      cacheTokenForAccount(configDir);
      cleanupTemp(tempDir);
      return result;
    });
  }
  const streamEnvOverrides = effectiveChatOnly
    ? getChatOnlyEnvOverrides(workspaceDir, configDir)
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
