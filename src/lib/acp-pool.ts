/**
 * Warm ACP process pool: one long-lived `agent acp` per account.
 * Busy workers are skipped; if none are free, a temporary process is spawned.
 */

import * as path from "node:path";
import { debuglog } from "node:util";

import {
  getAccountApiKeyEnv,
  readAccountApiKey,
  withAccountApiKeyArgs,
} from "./account-api-key.js";
import type { AcpStreamResult, AcpSyncResult } from "./acp-client.js";
import { AcpProcess } from "./acp-process.js";
import type { BridgeConfig } from "./config.js";
import type { CursorExecutionMode } from "./execution-mode.js";
import { getChatOnlyEnvOverrides } from "./workspace.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export class AcpWorkerBusyError extends Error {
  constructor(configDir: string | undefined) {
    super(
      `ACP warm worker busy${configDir ? ` for ${path.basename(configDir)}` : ""}`,
    );
    this.name = "AcpWorkerBusyError";
  }
}

export type AcpPoolPromptArgs = {
  configDir: string | undefined;
  workspaceDir: string;
  effectiveChatOnly: boolean;
  prompt: string;
  model?: string;
  mode: CursorExecutionMode;
  signal?: AbortSignal;
};

type WorkerEntry = {
  configDir: string | undefined;
  process: AcpProcess;
};

function acpArgsWithMode(acpArgs: string[], mode: CursorExecutionMode): string[] {
  const i = acpArgs.indexOf("acp");
  if (i === -1) return acpArgs;
  if (mode === "agent") return acpArgs;
  return [...acpArgs.slice(0, i + 1), "--mode", mode, ...acpArgs.slice(i + 1)];
}

export class AcpWarmPool {
  private workers = new Map<string, WorkerEntry>();
  private starting: Promise<void> | null = null;
  private shutDown = false;

  constructor(private readonly config: BridgeConfig) {}

  /** Key for workers without an account dir. */
  private static readonly DEFAULT_KEY = "";

  private keyFor(configDir: string | undefined): string {
    return configDir ?? AcpWarmPool.DEFAULT_KEY;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startWorkers();
    return this.starting;
  }

  private async startWorkers(): Promise<void> {
    const dirs =
      this.config.configDirs.length > 0
        ? this.config.configDirs
        : [undefined];

    const results = await Promise.allSettled(
      dirs.map((dir) => this.spawnWarm(dir)),
    );

    for (const r of results) {
      if (r.status === "rejected") {
        console.warn(
          `[acp-pool] failed to warm ACP worker: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`,
        );
      }
    }

    const n = this.workers.size;
    console.log(
      `[acp-pool] warmed ${n} ACP worker${n === 1 ? "" : "s"} (session/new per request)`,
    );
  }

  private buildEnvAndArgs(configDir: string | undefined): {
    args: string[];
    env: Record<string, string | undefined>;
    skipAuthenticate: boolean;
  } {
    let args = [...this.config.acpArgs];
    // Default mode on the warm process; per-prompt mode is also set via session config.
    args = acpArgsWithMode(args, this.config.mode);
    args = withAccountApiKeyArgs(args, configDir);

    const env: Record<string, string | undefined> = { ...this.config.acpEnv };
    const keyEnv = getAccountApiKeyEnv(configDir);
    if (keyEnv) Object.assign(env, keyEnv);
    const hasAccountApiKey = Boolean(keyEnv || readAccountApiKey(configDir));
    if (hasAccountApiKey) {
      delete env.CURSOR_CONFIG_DIR;
    } else if (configDir) {
      env.CURSOR_CONFIG_DIR = configDir;
    }

    return {
      args,
      env,
      skipAuthenticate: this.config.acpSkipAuthenticate || hasAccountApiKey,
    };
  }

  private async spawnWarm(
    configDir: string | undefined,
  ): Promise<WorkerEntry> {
    const { args, env, skipAuthenticate } = this.buildEnvAndArgs(configDir);
    const proc = await AcpProcess.spawn(configDir, {
      command: this.config.acpCommand,
      args,
      cwd: this.config.workspace,
      env,
      spawnOptions: this.config.acpSpawnOptions,
      skipAuthenticate,
      rawDebug: this.config.acpRawDebug,
      requestTimeoutMs: this.config.timeoutMs,
    });
    const entry: WorkerEntry = { configDir, process: proc };
    this.workers.set(this.keyFor(configDir), entry);
    debugAcp(
      "warm worker ready: %s",
      configDir ? path.basename(configDir) : "(default)",
    );
    return entry;
  }

  hasIdleWorker(excludingConfigDir?: string): boolean {
    const excludeKey =
      excludingConfigDir !== undefined
        ? this.keyFor(excludingConfigDir)
        : undefined;
    for (const [key, entry] of this.workers) {
      if (excludeKey !== undefined && key === excludeKey) continue;
      if (entry.process.isAlive && !entry.process.isBusy) return true;
    }
    return false;
  }

  private tryAcquire(
    configDir: string | undefined,
  ): WorkerEntry | null {
    const key = this.keyFor(configDir);
    const entry = this.workers.get(key);
    if (!entry) return null;
    if (!entry.process.isAlive) {
      this.workers.delete(key);
      return null;
    }
    if (!entry.process.tryAcquire()) return null;
    return entry;
  }

  private promptEnv(
    workspaceDir: string,
    effectiveChatOnly: boolean,
    configDir: string | undefined,
  ): Record<string, string | undefined> | undefined {
    if (!effectiveChatOnly) return undefined;
    const hasKey = Boolean(readAccountApiKey(configDir));
    return getChatOnlyEnvOverrides(
      workspaceDir,
      hasKey ? undefined : configDir,
    );
  }

  private toPromptOpts(args: AcpPoolPromptArgs) {
    return {
      cwd: args.workspaceDir,
      prompt: args.prompt,
      model: args.model,
      mode: args.mode,
      timeoutMs: this.config.timeoutMs,
      requestTimeoutMs: this.config.timeoutMs,
      signal: args.signal,
    };
  }

  /**
   * Run on the warm worker for `configDir`, or throw {@link AcpWorkerBusyError}
   * when that worker is busy and another idle warm worker exists (so failover
   * can try another account). When no idle warm worker remains, runs a
   * temporary one-shot process for this account.
   */
  async runSync(args: AcpPoolPromptArgs): Promise<AcpSyncResult> {
    await this.start();
    const entry = this.tryAcquire(args.configDir);
    if (entry) {
      try {
        return await entry.process.runSync(this.toPromptOpts(args));
      } finally {
        entry.process.release();
        if (!entry.process.isAlive) {
          this.workers.delete(this.keyFor(args.configDir));
        }
      }
    }

    if (this.hasIdleWorker(args.configDir)) {
      throw new AcpWorkerBusyError(args.configDir);
    }

    return this.runTempSync(args);
  }

  async runStream(
    args: AcpPoolPromptArgs,
    onChunk: (text: string) => void,
  ): Promise<AcpStreamResult> {
    await this.start();
    const entry = this.tryAcquire(args.configDir);
    if (entry) {
      try {
        return await entry.process.runStream(this.toPromptOpts(args), onChunk);
      } finally {
        entry.process.release();
        if (!entry.process.isAlive) {
          this.workers.delete(this.keyFor(args.configDir));
        }
      }
    }

    if (this.hasIdleWorker(args.configDir)) {
      throw new AcpWorkerBusyError(args.configDir);
    }

    return this.runTempStream(args, onChunk);
  }

  private async runTempSync(args: AcpPoolPromptArgs): Promise<AcpSyncResult> {
    console.log(
      `[acp-pool] all warm workers busy — spawning temporary ACP for ${
        args.configDir ? path.basename(args.configDir) : "default"
      }`,
    );
    const { args: spawnArgs, env, skipAuthenticate } = this.buildEnvAndArgs(
      args.configDir,
    );
    const chatEnv = this.promptEnv(
      args.workspaceDir,
      args.effectiveChatOnly,
      args.configDir,
    );
    if (chatEnv) Object.assign(env, chatEnv);

    const proc = await AcpProcess.spawn(args.configDir, {
      command: this.config.acpCommand,
      args: spawnArgs,
      cwd: args.workspaceDir,
      env,
      spawnOptions: this.config.acpSpawnOptions,
      skipAuthenticate,
      rawDebug: this.config.acpRawDebug,
      requestTimeoutMs: this.config.timeoutMs,
    });
    try {
      if (!proc.tryAcquire()) {
        return { code: 1, stdout: "", stderr: "temp ACP acquire failed" };
      }
      return await proc.runSync(this.toPromptOpts(args));
    } finally {
      proc.release();
      proc.kill();
    }
  }

  private async runTempStream(
    args: AcpPoolPromptArgs,
    onChunk: (text: string) => void,
  ): Promise<AcpStreamResult> {
    console.log(
      `[acp-pool] all warm workers busy — spawning temporary ACP for ${
        args.configDir ? path.basename(args.configDir) : "default"
      }`,
    );
    const { args: spawnArgs, env, skipAuthenticate } = this.buildEnvAndArgs(
      args.configDir,
    );
    const chatEnv = this.promptEnv(
      args.workspaceDir,
      args.effectiveChatOnly,
      args.configDir,
    );
    if (chatEnv) Object.assign(env, chatEnv);

    const proc = await AcpProcess.spawn(args.configDir, {
      command: this.config.acpCommand,
      args: spawnArgs,
      cwd: args.workspaceDir,
      env,
      spawnOptions: this.config.acpSpawnOptions,
      skipAuthenticate,
      rawDebug: this.config.acpRawDebug,
      requestTimeoutMs: this.config.timeoutMs,
    });
    try {
      if (!proc.tryAcquire()) {
        return { code: 1, stderr: "temp ACP acquire failed" };
      }
      return await proc.runStream(this.toPromptOpts(args), onChunk);
    } finally {
      proc.release();
      proc.kill();
    }
  }

  /** Replace a dead warm worker in the background (best-effort). */
  async respawnIfMissing(configDir: string | undefined): Promise<void> {
    if (this.shutDown) return;
    const key = this.keyFor(configDir);
    const existing = this.workers.get(key);
    if (existing?.process.isAlive) return;
    try {
      await this.spawnWarm(configDir);
    } catch (err) {
      console.warn(
        `[acp-pool] respawn failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  shutdown(): void {
    this.shutDown = true;
    for (const entry of this.workers.values()) {
      entry.process.kill();
    }
    this.workers.clear();
  }

  /** Test helper */
  getWorkerCount(): number {
    return this.workers.size;
  }
}

let globalPool: AcpWarmPool | null = null;

export function initAcpWarmPool(config: BridgeConfig): AcpWarmPool {
  if (globalPool) {
    globalPool.shutdown();
  }
  globalPool = new AcpWarmPool(config);
  return globalPool;
}

export function getAcpWarmPool(): AcpWarmPool | null {
  return globalPool;
}

export function shutdownAcpWarmPool(): void {
  if (globalPool) {
    globalPool.shutdown();
    globalPool = null;
  }
}

export async function startAcpWarmPool(config: BridgeConfig): Promise<void> {
  const pool = initAcpWarmPool(config);
  await pool.start();
}
