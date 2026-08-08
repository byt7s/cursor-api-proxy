/**
 * Bounded agent-run admission: global + per-account permits with a short wait.
 *
 * ACP/CLI children are heavy — defaults stay conservative (16 / 2).
 * In-process SDK runs are much lighter — separate higher caps (48 / 12).
 * Planes do not share counters so SDK load cannot starve ACP (or vice versa).
 */

import path from "node:path";

export type AdmissionPlane = "acp" | "sdk";

export type PlaneLimits = {
  maxConcurrentRuns: number;
  maxConcurrentRunsPerAccount: number;
};

export type AdmissionConfig = {
  waitMs: number;
  acp: PlaneLimits;
  sdk: PlaneLimits;
};

/** Partial configure shape (flat keys configure the ACP plane for back-compat). */
export type AdmissionConfigInput = {
  waitMs?: number;
  maxConcurrentRuns?: number;
  maxConcurrentRunsPerAccount?: number;
  sdkMaxConcurrentRuns?: number;
  sdkMaxConcurrentRunsPerAccount?: number;
  acp?: Partial<PlaneLimits>;
  sdk?: Partial<PlaneLimits>;
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
  plane: AdmissionPlane;
  accountKey: string;
  started: number;
  deadline: number;
  signal?: AbortSignal;
  timer?: NodeJS.Timeout;
  onAbort?: () => void;
  settled: boolean;
  resolve: (result: AdmitResult) => void;
};

type PlaneState = {
  globalInUse: number;
  perAccountInUse: Map<string, number>;
};

const DEFAULTS: AdmissionConfig = {
  waitMs: 5000,
  acp: {
    maxConcurrentRuns: 16,
    maxConcurrentRunsPerAccount: 2,
  },
  sdk: {
    maxConcurrentRuns: 48,
    maxConcurrentRunsPerAccount: 12,
  },
};

let cfg: AdmissionConfig = cloneConfig(DEFAULTS);
const planes: Record<AdmissionPlane, PlaneState> = {
  acp: { globalInUse: 0, perAccountInUse: new Map() },
  sdk: { globalInUse: 0, perAccountInUse: new Map() },
};
const waiters: Waiter[] = [];

function cloneConfig(c: AdmissionConfig): AdmissionConfig {
  return {
    waitMs: c.waitMs,
    acp: { ...c.acp },
    sdk: { ...c.sdk },
  };
}

function mergePlane(
  base: PlaneLimits,
  partial?: Partial<PlaneLimits>,
): PlaneLimits {
  return {
    maxConcurrentRuns: Math.max(
      0,
      partial?.maxConcurrentRuns ?? base.maxConcurrentRuns,
    ),
    maxConcurrentRunsPerAccount: Math.max(
      0,
      partial?.maxConcurrentRunsPerAccount ?? base.maxConcurrentRunsPerAccount,
    ),
  };
}

export function configureAdmission(partial: AdmissionConfigInput): void {
  const acpPartial: Partial<PlaneLimits> = {
    ...partial.acp,
  };
  if (partial.maxConcurrentRuns !== undefined) {
    acpPartial.maxConcurrentRuns = partial.maxConcurrentRuns;
  }
  if (partial.maxConcurrentRunsPerAccount !== undefined) {
    acpPartial.maxConcurrentRunsPerAccount = partial.maxConcurrentRunsPerAccount;
  }

  const sdkPartial: Partial<PlaneLimits> = {
    ...partial.sdk,
  };
  if (partial.sdkMaxConcurrentRuns !== undefined) {
    sdkPartial.maxConcurrentRuns = partial.sdkMaxConcurrentRuns;
  }
  if (partial.sdkMaxConcurrentRunsPerAccount !== undefined) {
    sdkPartial.maxConcurrentRunsPerAccount =
      partial.sdkMaxConcurrentRunsPerAccount;
  }

  cfg = {
    waitMs: Math.max(0, partial.waitMs ?? cfg.waitMs),
    acp: mergePlane(cfg.acp, acpPartial),
    sdk: mergePlane(cfg.sdk, sdkPartial),
  };
}

export function getAdmissionConfig(): AdmissionConfig & {
  /** @deprecated Prefer `acp.maxConcurrentRuns` — ACP plane (back-compat). */
  maxConcurrentRuns: number;
  /** @deprecated Prefer `acp.maxConcurrentRunsPerAccount`. */
  maxConcurrentRunsPerAccount: number;
} {
  return {
    ...cloneConfig(cfg),
    maxConcurrentRuns: cfg.acp.maxConcurrentRuns,
    maxConcurrentRunsPerAccount: cfg.acp.maxConcurrentRunsPerAccount,
  };
}

export function resetAdmissionForTests(): void {
  cfg = cloneConfig(DEFAULTS);
  for (const plane of Object.values(planes)) {
    plane.globalInUse = 0;
    plane.perAccountInUse.clear();
  }
  while (waiters.length) {
    settleWaiter(waiters[0]!, capacityResult(waiters[0]!.started));
  }
}

function limitsFor(plane: AdmissionPlane): PlaneLimits {
  return plane === "sdk" ? cfg.sdk : cfg.acp;
}

function accountInUse(plane: AdmissionPlane, accountKey: string): number {
  return planes[plane].perAccountInUse.get(accountKey) ?? 0;
}

function canAcquire(plane: AdmissionPlane, accountKey: string): boolean {
  const limits = limitsFor(plane);
  const state = planes[plane];
  if (limits.maxConcurrentRuns <= 0) return false;
  if (state.globalInUse >= limits.maxConcurrentRuns) return false;
  if (accountInUse(plane, accountKey) >= limits.maxConcurrentRunsPerAccount) {
    return false;
  }
  return true;
}

function acquire(plane: AdmissionPlane, accountKey: string): () => void {
  const state = planes[plane];
  state.globalInUse++;
  state.perAccountInUse.set(accountKey, accountInUse(plane, accountKey) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.globalInUse = Math.max(0, state.globalInUse - 1);
    const n = accountInUse(plane, accountKey) - 1;
    if (n <= 0) state.perAccountInUse.delete(accountKey);
    else state.perAccountInUse.set(accountKey, n);
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
    if (canAcquire(w.plane, w.accountKey)) {
      const release = acquire(w.plane, w.accountKey);
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

function waitingCount(plane?: AdmissionPlane): number {
  if (!plane) return waiters.length;
  return waiters.filter((w) => w.plane === plane).length;
}

/**
 * Acquire a run permit for accountKey on the given plane, waiting up to waitMs.
 * Always call release() exactly once when ok.
 */
export async function admitAgentRun(
  accountKey: string,
  opts?: {
    signal?: AbortSignal;
    waitMs?: number;
    /** Default `acp` (heavy CLI/ACP children). Use `sdk` for in-process engine. */
    plane?: AdmissionPlane;
  },
): Promise<AdmitResult> {
  const plane = opts?.plane ?? "acp";
  const key = accountKey || "default";
  const budget = opts?.waitMs ?? cfg.waitMs;
  const started = Date.now();

  if (opts?.signal?.aborted) {
    return abortedResult(started);
  }

  if (canAcquire(plane, key)) {
    const release = acquire(plane, key);
    return { ok: true, release, waitMs: 0 };
  }

  if (budget <= 0) {
    return capacityResult(started);
  }

  const deadline = started + budget;
  return new Promise<AdmitResult>((resolve) => {
    const waiter: Waiter = {
      plane,
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

function planeSnapshot(plane: AdmissionPlane) {
  const state = planes[plane];
  return {
    globalInUse: state.globalInUse,
    perAccount: Object.fromEntries(state.perAccountInUse),
    waiting: waitingCount(plane),
  };
}

/** Snapshot for tests / status. Top-level fields mirror the ACP plane (back-compat). */
export function getAdmissionSnapshot(): {
  globalInUse: number;
  perAccount: Record<string, number>;
  waiting: number;
  acp: {
    globalInUse: number;
    perAccount: Record<string, number>;
    waiting: number;
  };
  sdk: {
    globalInUse: number;
    perAccount: Record<string, number>;
    waiting: number;
  };
} {
  const acp = planeSnapshot("acp");
  const sdk = planeSnapshot("sdk");
  return {
    globalInUse: acp.globalInUse,
    perAccount: acp.perAccount,
    waiting: acp.waiting,
    acp,
    sdk,
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
