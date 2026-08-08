import * as path from "node:path";

import {
  getAccountPoolSize,
  getNextAccountConfigDir,
  getUsableCount,
  reportRateLimit,
  reportRequestEnd,
  reportRequestError,
  reportRequestStart,
  reportRequestSuccess,
} from "./account-pool.js";
import { applyPlanUpgradeQuarantine } from "./account-quarantine.js";
import { logAccountAssigned } from "./request-log.js";

const RATE_LIMIT_PENALTY_MS = 60000;

export function isRateLimited(stderr: string): boolean {
  return /\b429\b|rate.?limit|too many requests/i.test(stderr);
}

export type AgentAttemptResult = {
  code: number;
  stdout?: string;
  stderr: string;
};

export type SyncFailoverSuccess<T extends AgentAttemptResult> = {
  status: "ok" | "error";
  result: T;
  configDir: string | undefined;
  latencyMs: number;
};

export type SyncFailoverAllRateLimited = {
  status: "all_rate_limited";
  result?: AgentAttemptResult;
  configDir?: string;
  latencyMs: number;
};

export type SyncFailoverAllDisabled = {
  status: "all_disabled";
  result?: AgentAttemptResult;
  configDir?: string;
  latencyMs: number;
};

export type SyncFailoverAborted = {
  status: "aborted";
};

export type SyncFailoverOutcome<T extends AgentAttemptResult> =
  | SyncFailoverSuccess<T>
  | SyncFailoverAllRateLimited
  | SyncFailoverAllDisabled
  | SyncFailoverAborted;

function poolExhaustedStatus(): "all_disabled" | "all_rate_limited" {
  if (getAccountPoolSize() > 0 && getUsableCount() === 0) {
    return "all_disabled";
  }
  return "all_rate_limited";
}

/**
 * Run a sync agent attempt, silently retrying on other accounts when the CLI
 * reports a rate limit or a plan-upgrade quarantine. Only fails with
 * all_rate_limited / all_disabled when no usable account remains.
 */
export async function runSyncWithAccountFailover<T extends AgentAttemptResult>(
  runOnce: (configDir: string | undefined) => Promise<T>,
  signal?: AbortSignal,
): Promise<SyncFailoverOutcome<T>> {
  const tried = new Set<string>();
  let lastRateLimited: {
    result: T;
    configDir: string | undefined;
    latencyMs: number;
  } | undefined;

  while (!signal?.aborted) {
    const configDir = getNextAccountConfigDir({ exclude: tried });
    if (!configDir) {
      // Pool has accounts but none are available (disabled / rate-limited / excluded).
      if (getAccountPoolSize() > 0) {
        return {
          status: poolExhaustedStatus(),
          result: lastRateLimited?.result,
          configDir: lastRateLimited?.configDir,
          latencyMs: lastRateLimited?.latencyMs ?? 0,
        };
      }

      // No pool configured: allow one attempt without a dir.
      if (tried.size === 0) {
        const start = Date.now();
        reportRequestStart(undefined);
        logAccountAssigned(undefined);
        try {
          const result = await runOnce(undefined);
          const latencyMs = Date.now() - start;
          if (applyPlanUpgradeQuarantine(undefined, result) === "plan_upgrade") {
            reportRequestError(undefined, latencyMs);
            return {
              status: "all_disabled",
              result,
              configDir: undefined,
              latencyMs,
            };
          }
          if (result.stderr && isRateLimited(result.stderr)) {
            reportRateLimit(undefined, RATE_LIMIT_PENALTY_MS);
            reportRequestError(undefined, latencyMs);
            return {
              status: "all_rate_limited",
              result,
              configDir: undefined,
              latencyMs,
            };
          }
          if (result.code !== 0) {
            reportRequestError(undefined, latencyMs);
            return {
              status: "error",
              result,
              configDir: undefined,
              latencyMs,
            };
          }
          reportRequestSuccess(undefined, latencyMs);
          return {
            status: "ok",
            result,
            configDir: undefined,
            latencyMs,
          };
        } finally {
          reportRequestEnd(undefined);
        }
      }

      return {
        status: poolExhaustedStatus(),
        result: lastRateLimited?.result,
        configDir: lastRateLimited?.configDir,
        latencyMs: lastRateLimited?.latencyMs ?? 0,
      };
    }

    tried.add(configDir);
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const start = Date.now();

    try {
      const result = await runOnce(configDir);
      const latencyMs = Date.now() - start;

      if (signal?.aborted) {
        return { status: "aborted" };
      }

      if (applyPlanUpgradeQuarantine(configDir, result) === "plan_upgrade") {
        reportRequestError(configDir, latencyMs);
        console.log(
          `[${new Date().toISOString()}] account ${path.basename(configDir)} plan-upgrade quarantine; trying another account`,
        );
        continue;
      }

      if (result.stderr && isRateLimited(result.stderr)) {
        reportRateLimit(configDir, RATE_LIMIT_PENALTY_MS);
        reportRequestError(configDir, latencyMs);
        lastRateLimited = { result, configDir, latencyMs };
        console.log(
          `[${new Date().toISOString()}] account ${path.basename(configDir)} rate-limited; trying another account`,
        );
        continue;
      }

      if (result.code !== 0) {
        reportRequestError(configDir, latencyMs);
        return { status: "error", result, configDir, latencyMs };
      }

      reportRequestSuccess(configDir, latencyMs);
      return { status: "ok", result, configDir, latencyMs };
    } finally {
      reportRequestEnd(configDir);
    }
  }

  return { status: "aborted" };
}

export type StreamFailoverSuccess = {
  status: "ok" | "error";
  code: number;
  stderr: string;
  configDir: string | undefined;
  latencyMs: number;
  committed: boolean;
};

export type StreamFailoverAllRateLimited = {
  status: "all_rate_limited";
  code: number;
  stderr: string;
  configDir?: string;
  latencyMs: number;
  committed: false;
};

export type StreamFailoverAllDisabled = {
  status: "all_disabled";
  code: number;
  stderr: string;
  configDir?: string;
  latencyMs: number;
  committed: false;
};

export type StreamFailoverAborted = {
  status: "aborted";
  committed: boolean;
};

export type StreamFailoverOutcome =
  | StreamFailoverSuccess
  | StreamFailoverAllRateLimited
  | StreamFailoverAllDisabled
  | StreamFailoverAborted;

/**
 * Stream with silent account failover while no content has been committed yet.
 * `onCommit` runs once, right before the first chunk is delivered (or after a
 * successful empty completion). After commit, rate-limit cannot be retried.
 */
export async function runStreamWithAccountFailover(opts: {
  signal?: AbortSignal;
  runOnce: (
    configDir: string | undefined,
    onChunk: (chunk: string) => void,
  ) => Promise<{ code: number; stderr: string }>;
  /** Called once before the first client-visible chunk (or on clean empty success). */
  onCommit: () => void;
  onChunk: (chunk: string) => void;
}): Promise<StreamFailoverOutcome> {
  const { signal, runOnce, onCommit, onChunk } = opts;
  const tried = new Set<string>();
  let committed = false;
  let lastRateLimited: {
    code: number;
    stderr: string;
    configDir: string | undefined;
    latencyMs: number;
  } | undefined;

  const deliver = (chunk: string) => {
    if (!committed) {
      committed = true;
      onCommit();
    }
    onChunk(chunk);
  };

  while (!signal?.aborted) {
    const configDir = getNextAccountConfigDir({ exclude: tried });
    if (!configDir) {
      if (getAccountPoolSize() > 0) {
        const status = poolExhaustedStatus();
        return {
          status,
          code: lastRateLimited?.code ?? 1,
          stderr:
            lastRateLimited?.stderr ??
            (status === "all_disabled"
              ? ALL_ACCOUNTS_DISABLED_MESSAGE
              : "All Cursor accounts are rate-limited"),
          configDir: lastRateLimited?.configDir,
          latencyMs: lastRateLimited?.latencyMs ?? 0,
          committed: false,
        };
      }

      if (tried.size === 0) {
        // No configured accounts — single attempt with undefined dir.
        reportRequestStart(undefined);
        logAccountAssigned(undefined);
        const start = Date.now();
        try {
          const { code, stderr } = await runOnce(undefined, deliver);
          const latencyMs = Date.now() - start;
          if (
            !committed &&
            applyPlanUpgradeQuarantine(undefined, { code, stderr }) ===
              "plan_upgrade"
          ) {
            reportRequestError(undefined, latencyMs);
            return {
              status: "all_disabled",
              code,
              stderr,
              configDir: undefined,
              latencyMs,
              committed: false,
            };
          }
          if (stderr && isRateLimited(stderr) && !committed) {
            reportRateLimit(undefined, RATE_LIMIT_PENALTY_MS);
            reportRequestError(undefined, latencyMs);
            return {
              status: "all_rate_limited",
              code,
              stderr,
              configDir: undefined,
              latencyMs,
              committed: false,
            };
          }
          if (!committed && code === 0) {
            committed = true;
            onCommit();
          }
          if (code !== 0) {
            reportRequestError(undefined, latencyMs);
            return {
              status: "error",
              code,
              stderr,
              configDir: undefined,
              latencyMs,
              committed,
            };
          }
          reportRequestSuccess(undefined, latencyMs);
          return {
            status: "ok",
            code,
            stderr,
            configDir: undefined,
            latencyMs,
            committed,
          };
        } finally {
          reportRequestEnd(undefined);
        }
      }

      const status = poolExhaustedStatus();
      return {
        status,
        code: lastRateLimited?.code ?? 1,
        stderr:
          lastRateLimited?.stderr ??
          (status === "all_disabled"
            ? ALL_ACCOUNTS_DISABLED_MESSAGE
            : "All Cursor accounts are rate-limited"),
        configDir: lastRateLimited?.configDir,
        latencyMs: lastRateLimited?.latencyMs ?? 0,
        committed: false,
      };
    }

    tried.add(configDir);
    logAccountAssigned(configDir);
    reportRequestStart(configDir);
    const start = Date.now();
    let sawChunk = false;

    try {
      const { code, stderr } = await runOnce(configDir, (chunk) => {
        sawChunk = true;
        deliver(chunk);
      });
      const latencyMs = Date.now() - start;

      if (signal?.aborted) {
        return { status: "aborted", committed };
      }

      if (
        !committed &&
        !sawChunk &&
        applyPlanUpgradeQuarantine(configDir, { code, stderr }) ===
          "plan_upgrade"
      ) {
        reportRequestError(configDir, latencyMs);
        console.log(
          `[${new Date().toISOString()}] account ${path.basename(configDir)} plan-upgrade quarantine; trying another account`,
        );
        continue;
      }

      if (stderr && isRateLimited(stderr)) {
        reportRateLimit(configDir, RATE_LIMIT_PENALTY_MS);
        if (!committed && !sawChunk) {
          reportRequestError(configDir, latencyMs);
          lastRateLimited = { code, stderr, configDir, latencyMs };
          console.log(
            `[${new Date().toISOString()}] account ${path.basename(configDir)} rate-limited; trying another account`,
          );
          continue;
        }
        // Already committed content to the client — cannot silently failover.
        reportRequestError(configDir, latencyMs);
        return {
          status: "error",
          code,
          stderr,
          configDir,
          latencyMs,
          committed,
        };
      }

      if (!committed && code === 0) {
        committed = true;
        onCommit();
      }

      if (code !== 0) {
        reportRequestError(configDir, latencyMs);
        return {
          status: "error",
          code,
          stderr,
          configDir,
          latencyMs,
          committed,
        };
      }

      reportRequestSuccess(configDir, latencyMs);
      return {
        status: "ok",
        code,
        stderr,
        configDir,
        latencyMs,
        committed,
      };
    } finally {
      reportRequestEnd(configDir);
    }
  }

  return { status: "aborted", committed };
}

export const ALL_ACCOUNTS_RATE_LIMITED_MESSAGE =
  "All Cursor accounts are currently rate-limited. Try again shortly.";

export const ALL_ACCOUNTS_DISABLED_MESSAGE =
  "No usable Cursor accounts (all disabled).";
