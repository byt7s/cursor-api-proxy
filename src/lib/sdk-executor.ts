import type { AgentRunResult } from "./agent-runner.js";
import { resolveSdkModel } from "./sdk-model-map.js";

export type SdkRunOptions = {
  prompt: string;
  /** Flat model id as it flows through the proxy. */
  cursorModel?: string;
  cwd: string;
  apiKey: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
  onThought?: (text: string) => void;
};

type SdkModule = typeof import("@cursor/sdk");

let sdkModule: Promise<SdkModule> | undefined;

/**
 * Lazy-load `@cursor/sdk` so ACP/CLI paths never require Node >= 22.13.
 * Import only happens when engine=sdk for a request.
 */
function loadSdk(): Promise<SdkModule> {
  sdkModule ??= import("@cursor/sdk").catch((err: unknown) => {
    sdkModule = undefined;
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `failed to load @cursor/sdk (requires Node >= 22.13): ${detail}`,
    );
  });
  return sdkModule;
}

/** Exported for tests — clear the cached dynamic import between cases. */
export function resetSdkModuleForTests(): void {
  sdkModule = undefined;
}

function failure(message: string): AgentRunResult {
  return {
    code: 1,
    stdout: "",
    stderr: message,
    failureText: message,
  };
}

function stoppedMessage(signal?: AbortSignal): string {
  return signal?.aborted ? "aborted" : "sdk_run_timeout";
}

/**
 * One-shot SDK run: Agent.create → send → wait → dispose.
 * Cancellation uses the run handle (not AbortSignal) once send() resolves.
 */
export async function runSdkAgent(
  opts: SdkRunOptions,
): Promise<AgentRunResult> {
  const model = resolveSdkModel(opts.cursorModel);
  if (!model) return failure("sdk_model_unresolved");
  if (opts.signal?.aborted) return failure("aborted");

  const text: string[] = [];
  const thoughts: string[] = [];

  let stopReason: string | undefined;
  let cancelRun: ((reason: string) => void) | undefined;
  const stop = (reason: string) => {
    stopReason ??= reason;
    cancelRun?.(reason);
  };

  const onAbort = () => stop("client aborted");
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const deadline =
    opts.timeoutMs > 0
      ? setTimeout(() => stop("deadline exceeded"), opts.timeoutMs)
      : undefined;

  let agent: Awaited<ReturnType<SdkModule["Agent"]["create"]>> | undefined;
  try {
    const sdk = await loadSdk();
    if (stopReason) return failure(stoppedMessage(opts.signal));

    agent = await sdk.Agent.create({
      apiKey: opts.apiKey,
      model,
      local: {
        cwd: opts.cwd,
        settingSources: [],
      },
    });

    if (stopReason) return failure(stoppedMessage(opts.signal));

    const run = await agent.send(opts.prompt, {
      onDelta: ({ update }) => {
        if (update.type === "text-delta") {
          text.push(update.text);
          opts.onChunk?.(update.text);
          return;
        }
        if (update.type === "thinking-delta") {
          thoughts.push(update.text);
          opts.onThought?.(update.text);
        }
      },
    });

    let cancelling = false;
    cancelRun = (reason: string) => {
      if (cancelling || !run.supports("cancel")) return;
      cancelling = true;
      console.warn(`[sdk] cancelling run ${run.id} (${reason})`);
      void run.cancel().catch(() => {});
    };
    if (stopReason) cancelRun(stopReason);

    const result = await run.wait();
    const stdout = result.result ?? text.join("");
    const reasoning = thoughts.length ? thoughts.join("") : undefined;

    if (result.status === "finished") {
      return { code: 0, stdout, stderr: "", reasoning };
    }
    const message =
      result.status === "cancelled"
        ? opts.signal?.aborted
          ? "aborted"
          : "sdk_run_timeout"
        : (result.error?.message ?? "sdk_run_error");
    return {
      code: 1,
      stdout,
      stderr: message,
      failureText: message,
      reasoning,
    };
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  } finally {
    if (deadline) clearTimeout(deadline);
    opts.signal?.removeEventListener("abort", onAbort);
    if (agent) {
      try {
        await agent[Symbol.asyncDispose]();
      } catch {
        /* disposal is best effort */
      }
    }
  }
}
