/**
 * Long-lived ACP child: initialize/authenticate once, then session/new per prompt.
 */

import * as readline from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { debuglog } from "node:util";

import {
  buildAcpSpawnEnv,
  handleAcpNotification,
  parseAcpStdoutLine,
  resolveAcpModelConfigValue,
  sendAcpRequest,
  type AcpAvailableModel,
  type AcpStreamResult,
  type AcpSyncResult,
} from "./acp-client.js";
import { trackChildProcess } from "./process.js";
import { DETACH_CHILDREN, killProcessTree } from "./process-tree-kill.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type AcpProcessSpawnOptions = {
  command: string;
  args: string[];
  /** Stable cwd for the OS process (session cwd is set per prompt). */
  cwd: string;
  env?: Record<string, string | undefined>;
  spawnOptions?: { windowsVerbatimArguments?: boolean };
  skipAuthenticate?: boolean;
  rawDebug?: boolean;
  requestTimeoutMs?: number;
};

export type AcpProcessPromptOptions = {
  cwd: string;
  prompt: string;
  model?: string;
  mode?: string;
  timeoutMs: number;
  requestTimeoutMs?: number;
  signal?: AbortSignal;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timerId?: ReturnType<typeof setTimeout>;
};

/**
 * One warm (or temporary) `agent acp` process. Not safe for concurrent prompts —
 * callers must serialize via tryAcquire/release.
 */
export class AcpProcess {
  readonly configDir: string | undefined;
  private child: ChildProcess;
  private readonly rl: readline.Interface;
  private readonly nextId = { current: 1 };
  private readonly pending = new Map<number, Pending>();
  private readonly rawDebug: boolean;
  private readonly defaultRequestTimeoutMs: number;
  private dead = false;
  private busy = false;
  private stderr = "";

  private constructor(
    configDir: string | undefined,
    child: ChildProcess,
    opts: { rawDebug: boolean; requestTimeoutMs: number },
  ) {
    this.configDir = configDir;
    this.child = child;
    this.rawDebug = opts.rawDebug;
    this.defaultRequestTimeoutMs = opts.requestTimeoutMs;
    this.rl = readline.createInterface({ input: child.stdout! });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      this.stderr += chunk;
    });

    this.rl.on("line", (line: string) => {
      try {
        if (this.rawDebug) debugAcp("ACP raw: %s", line);
        const msg = parseAcpStdoutLine(line);
        if (!msg) return;

        if (
          msg.id != null &&
          (msg.result !== undefined || msg.error !== undefined)
        ) {
          const reqId = typeof msg.id === "number" ? msg.id : Number(msg.id);
          const waiter = Number.isFinite(reqId)
            ? this.pending.get(reqId)
            : undefined;
          if (waiter) {
            this.pending.delete(reqId);
            if (msg.error) {
              waiter.reject(new Error(msg.error.message ?? "ACP error"));
            } else {
              waiter.resolve(msg.result);
            }
          }
          return;
        }

        const handlers = this.activeHandlers;
        handleAcpNotification(msg, {
          rawDebug: this.rawDebug,
          stdin: child.stdin,
          onAgentTextChunk: handlers?.onText,
          onAgentThoughtChunk: handlers?.onThought,
        });
      } catch {
        /* ignore */
      }
    });

    child.on("error", () => {
      this.markDead(new Error("ACP child process error"));
    });
    child.on("close", (code) => {
      this.markDead(new Error(`ACP child exited with code ${code ?? 1}`));
    });
  }

  private activeHandlers:
    | { onText?: (t: string) => void; onThought?: (t: string) => void }
    | null = null;

  get isAlive(): boolean {
    return !this.dead && this.child.exitCode === null;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  get takeStderr(): string {
    return this.stderr;
  }

  static async spawn(
    configDir: string | undefined,
    opts: AcpProcessSpawnOptions,
  ): Promise<AcpProcess> {
    const requestTimeoutMs =
      opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: buildAcpSpawnEnv(opts.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: opts.spawnOptions?.windowsVerbatimArguments,
      detached: DETACH_CHILDREN,
    });
    trackChildProcess(child);

    const proc = new AcpProcess(configDir, child, {
      rawDebug: Boolean(opts.rawDebug),
      requestTimeoutMs,
    });

    if (!child.stdin) {
      proc.kill();
      throw new Error("ACP child has no stdin");
    }

    try {
      debugAcp("ACP warm: initialize");
      await sendAcpRequest(
        child.stdin,
        proc.nextId,
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "cursor-api-proxy", version: "0.1.0" },
        },
        proc.pending,
        requestTimeoutMs,
      );

      if (!opts.skipAuthenticate) {
        debugAcp("ACP warm: authenticate");
        await sendAcpRequest(
          child.stdin,
          proc.nextId,
          "authenticate",
          { methodId: "cursor_login" },
          proc.pending,
          requestTimeoutMs,
        );
      } else {
        debugAcp("ACP warm: authenticate (skipped)");
      }
    } catch (err) {
      proc.kill();
      throw err;
    }

    return proc;
  }

  tryAcquire(): boolean {
    if (!this.isAlive || this.busy) return false;
    this.busy = true;
    return true;
  }

  release(): void {
    this.busy = false;
    this.activeHandlers = null;
  }

  async runSync(opts: AcpProcessPromptOptions): Promise<AcpSyncResult> {
    let accumulated = "";
    let accumulatedThought = "";
    const result = await this.runPrompt(opts, {
      onText: (t) => {
        accumulated += t;
      },
      onThought: (t) => {
        accumulatedThought += t;
      },
    });
    const reasoning = accumulatedThought.trim();
    return {
      code: result.code,
      stdout: accumulated.trim(),
      stderr: result.stderr,
      ...(reasoning ? { reasoning } : {}),
    };
  }

  async runStream(
    opts: AcpProcessPromptOptions,
    onChunk: (text: string) => void,
    onThought?: (text: string) => void,
  ): Promise<AcpStreamResult> {
    return this.runPrompt(opts, { onText: onChunk, onThought });
  }

  private async runPrompt(
    opts: AcpProcessPromptOptions,
    handlers: { onText?: (t: string) => void; onThought?: (t: string) => void },
  ): Promise<AcpStreamResult> {
    if (!this.isAlive || !this.child.stdin) {
      return { code: 1, stderr: "ACP process is dead" };
    }

    const requestTimeoutMs =
      opts.requestTimeoutMs ?? this.defaultRequestTimeoutMs;
    const stderrBefore = this.stderr.length;
    this.activeHandlers = handlers;

    const onAbort = () => {
      // Do not kill the warm process on abort — just reject in-flight RPC.
      for (const [id, waiter] of Array.from(this.pending.entries())) {
        this.pending.delete(id);
        if (waiter.timerId) clearTimeout(waiter.timerId);
        waiter.reject(new Error("ACP prompt aborted"));
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const overallTimer =
      opts.timeoutMs > 0
        ? setTimeout(() => {
            onAbort();
          }, opts.timeoutMs)
        : undefined;

    try {
      debugAcp("ACP step: session/new");
      const sessionResult = (await sendAcpRequest(
        this.child.stdin,
        this.nextId,
        "session/new",
        { cwd: opts.cwd, mcpServers: [] },
        this.pending,
        requestTimeoutMs,
      )) as {
        sessionId?: string;
        models?: { availableModels?: AcpAvailableModel[] };
      };
      const sessionId = sessionResult?.sessionId;
      if (!sessionId) {
        return {
          code: 1,
          stderr: this.stderr.slice(stderrBefore).trim() || "session/new failed",
        };
      }

      if (opts.model) {
        const resolvedModelId = resolveAcpModelConfigValue(
          opts.model,
          sessionResult.models?.availableModels,
        );
        if (resolvedModelId !== "default" && resolvedModelId !== "default[]") {
          debugAcp("ACP step: session/set_config_option (model)");
          try {
            await sendAcpRequest(
              this.child.stdin,
              this.nextId,
              "session/set_config_option",
              { sessionId, configId: "model", value: resolvedModelId },
              this.pending,
              requestTimeoutMs,
            );
          } catch (err) {
            debugAcp("ACP set model failed: %s", String(err));
          }
        }
      }

      if (opts.mode && opts.mode !== "agent") {
        debugAcp("ACP step: session/set_config_option (mode)");
        try {
          await sendAcpRequest(
            this.child.stdin,
            this.nextId,
            "session/set_config_option",
            { sessionId, configId: "mode", value: opts.mode },
            this.pending,
            requestTimeoutMs,
          );
        } catch {
          /* mode option may be unsupported — ignore */
        }
      }

      debugAcp("ACP step: session/prompt");
      await sendAcpRequest(
        this.child.stdin,
        this.nextId,
        "session/prompt",
        { sessionId, prompt: [{ type: "text", text: opts.prompt }] },
        this.pending,
        requestTimeoutMs,
      );

      return {
        code: 0,
        stderr: this.stderr.slice(stderrBefore).trim(),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed out|aborted/i.test(msg) && opts.timeoutMs > 0) {
        return {
          code: 124,
          stderr: this.stderr.slice(stderrBefore).trim() || msg,
        };
      }
      return {
        code: 1,
        stderr: this.stderr.slice(stderrBefore).trim() || msg,
      };
    } finally {
      if (overallTimer) clearTimeout(overallTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      this.activeHandlers = null;
    }
  }

  kill(): void {
    this.dead = true;
    this.busy = false;
    try {
      this.rl.close();
    } catch {
      /* ignore */
    }
    try {
      this.child.stdin?.end();
    } catch {
      /* ignore */
    }
    killProcessTree(this.child, "SIGKILL");
  }

  private markDead(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    this.busy = false;
    for (const [id, waiter] of Array.from(this.pending.entries())) {
      this.pending.delete(id);
      if (waiter.timerId) clearTimeout(waiter.timerId);
      waiter.reject(err);
    }
  }
}
