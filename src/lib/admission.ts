/**
 * Bounded agent-run admission: global + per-account permits with a short wait.
 *
 * Defaults are tuned for ACP/CLI children (much heavier than in-process SDK runs).
 * Raise CURSOR_BRIDGE_MAX_CONCURRENT_RUNS* if you have headroom; lower them to
 * protect memory and upstream rate limits.
 */

import path from "node:path";

export type AdmissionConfig = {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerAccount: number;
  waitMs: number;
};

export type AdmitResult =
  | { ok: true; release: () => void; waitMs: number }
  | {
      ok: false;
      reason: "capacity";
      retryAfterMs: number;
      waitMs: number;
    }
  | { ok: false; reason: "aborted"; waitMs: number };

type Waiter = {
  accountKey: string;
  started: number;
  deadline: number;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  settled: boolean;
  resolve: (result: AdmitResult) => void;
};

const DEFAULTS: AdmissionConfig = {
  maxConcurrentRuns: 16,
  maxConcurrentRunsPerAccount: 2,
  waitMs: 5000,
};

let cfg: AdmissionConfig = { ...DEFAULTS };
let globalInUse = 0;
const perAccountInUse = new Map<string, number>();
const waiters: Waiter[] = [];

export function configureAdmission(partial: Partial<AdmissionConfig>): void {
  cfg = {
    maxConcurrentRuns: Math.max(
      0,
      partial.maxConcurrentRuns ?? cfg.maxConcurrentRuns,
    ),
    maxConcurrentRunsPerAccount: Math.max(
      0,
      partial.maxConcurrentRunsPerAccount ?? cfg.maxConcurrentRunsPerAccount,
    ),
    waitMs: Math.max(0, partial.waitMs ?? cfg.waitMs),
  };
}

export function getAdmissionConfig(): AdmissionConfig {
  return { ...cfg };
}

export function resetAdmissionForTests(): void {
  cfg = { ...DEFAULTS };
  globalInUse = 0;
  perAccountInUse.clear();
  while (waiters.length) {
    settleWaiter(waiters[0]!, capacityResult(waiters[0]!.started));
  }
}

function accountInUse(accountKey: string): number {
  return perAccountInUse.get(accountKey) ?? 0;
}

function canAcquire(accountKey: string): boolean {
  if (cfg.maxConcurrentRuns <= 0) return false;
  if (globalInUse >= cfg.maxConcurrentRuns) return false;
  if (accountInUse(accountKey) >= cfg.maxConcurrentRunsPerAccount) return false;
  return true;
}

function acquire(accountKey: string): () => void {
  globalInUse++;
  perAccountInUse.set(accountKey, accountInUse(accountKey) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    globalInUse = Math.max(0, globalInUse - 1);
    const n = accountInUse(accountKey) - 1;
    if (n <= 0) perAccountInUse.delete(accountKey);
    else perAccountInUse.set(accountKey, n);
    wakeWaiters();
  };
}

function retryAfterMs(): number {
  return Math.max(1, Math.ceil(cfg.waitMs / 1000) * 1000);
}

function capacityResult(started: number): AdmitResult {
  return {
    ok: false,
    reason: "capacity",
    retryAfterMs: retryAfterMs(),
    waitMs: Date.now() - started,
  };
}

function abortedResult(started: number): AdmitResult {
  return {
    ok: false,
    reason: "aborted",
    waitMs: Date.now() - started,
  };
}

function settleWaiter(waiter: Waiter, result: AdmitResult): void {
  if (waiter.settled) return;
  waiter.settled = true;
  const index = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  if (waiter.timer) clearTimeout(waiter.timer);
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
  waiter.resolve(result);
}

function wakeWaiters(): void {
  const now = Date.now();
  for (let i = 0; i < waiters.length; ) {
    const w = waiters[i]!;
    if (now >= w.deadline) {
      settleWaiter(w, capacityResult(w.started));
      continue;
    }
    if (w.signal?.aborted) {
      settleWaiter(w, abortedResult(w.started));
      continue;
    }
    if (canAcquire(w.accountKey)) {
      const release = acquire(w.accountKey);
      settleWaiter(w, {
        ok: true,
        release,
        waitMs: now - w.started,
      });
      continue;
    }
    i++;
  }
}

/**
 * Acquire a run permit for accountKey, waiting up to waitMs.
 * Always call release() exactly once when ok.
 */
export async function admitAgentRun(
  accountKey: string,
  opts?: { signal?: AbortSignal; waitMs?: number },
): Promise<AdmitResult> {
  const key = accountKey || "default";
  const budget = opts?.waitMs || cfg.waitMs;
  const started = Date.now();

  if (opts?.signal?.aborted) {
    return abortedResult(started);
  }

  if (canAcquire(key)) {
    const release = acquire(key);
    return { ok: true, release, waitMs: 0 };
  }

  if (budget <= 0) {
    return capacityResult(started);
  }

  const deadline = started + budget;
  return new Promise<AdmitResult>((resolve) => {
    const waiter: Waiter = {
      accountKey: key,
      started,
      deadline,
      signal: opts?.signal,
      settled: false,
      resolve,
    };
    waiters.push(waiter);
    const remaining = Math.max(0, deadline - Date.now());
    waiter.timer = setTimeout(() => {
      settleWaiter(waiter, capacityResult(started));
    }, remaining);
    if (opts?.signal) {
      waiter.onAbort = () => {
        settleWaiter(waiter, abortedResult(started));
      };
      opts.signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (opts.signal.aborted) waiter.onAbort();
    }
  });
}

/** Snapshot for tests / status. */
export function getAdmissionSnapshot(): {
  globalInUse: number;
  perAccount: Record<string, number>;
  waiting: number;
} {
  return {
    globalInUse,
    perAccount: Object.fromEntries(perAccountInUse),
    waiting: waiters.length,
  };
}

/** Stable identity for admission / pool keys. */
export function accountKeyFor(configDir: string | undefined): string {
  if (!configDir) return "default";
  return path.resolve(configDir);
}

export class AdmissionCapacityError extends Error {
  readonly retryAfterMs: number;
  readonly code = "agent_capacity" as const;

  constructor(retryAfterMs: number) {
    super("Agent capacity exceeded");
    this.name = "AdmissionCapacityError";
    this.retryAfterMs = retryAfterMs;
  }
}

export const AGENT_CAPACITY_MESSAGE =
  "Agent capacity exceeded. Retry shortly.";

export function isAdmissionCapacityError(
  err: unknown,
): err is AdmissionCapacityError {
  return err instanceof AdmissionCapacityError;
}
