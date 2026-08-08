type AccountStatus = {
  configDir: string;
  activeRequests: number;
  lastUsed: number;
  rateLimitUntil: number;
  totalRequests: number;
  totalSuccess: number;
  totalErrors: number;
  totalRateLimits: number;
  totalLatencyMs: number;
  disabled: boolean;
  disabledReason: string;
  disabledAt: number;
};

export type AccountStat = {
  configDir: string;
  activeRequests: number;
  totalRequests: number;
  totalSuccess: number;
  totalErrors: number;
  totalRateLimits: number;
  totalLatencyMs: number;
  isRateLimited: boolean;
  rateLimitUntil: number;
  isDisabled: boolean;
  disabledReason: string;
  disabledAt: number;
};

export type GetNextConfigDirOptions = {
  /** Config dirs already tried in this request (e.g. hit rate limit). */
  exclude?: ReadonlySet<string>;
  /**
   * Sticky session pin: try this account first when still usable (not
   * excluded / disabled / rate-limited).
   */
  prefer?: string;
  /**
   * When true (default false), if every account is rate-limited, pick the one
   * that recovers soonest. Failover paths leave this false so the caller can
   * return an error instead of forcing a doomed attempt.
   */
  allowRateLimitedFallback?: boolean;
};

export class AccountPool {
  private accounts: AccountStatus[];

  constructor(configDirs: string[]) {
    this.accounts = configDirs.map((dir) => ({
      configDir: dir,
      activeRequests: 0,
      lastUsed: 0,
      rateLimitUntil: 0,
      totalRequests: 0,
      totalSuccess: 0,
      totalErrors: 0,
      totalRateLimits: 0,
      totalLatencyMs: 0,
      disabled: false,
      disabledReason: "",
      disabledAt: 0,
    }));
  }

  /**
   * Get the least busy account using a combination of active requests and round-robin.
   * Never returns permanently disabled accounts. Among the rest, ignores accounts
   * that are currently rate limited (unless allowRateLimitedFallback).
   */
  public getNextConfigDir(
    options: GetNextConfigDirOptions = {},
  ): string | undefined {
    if (this.accounts.length === 0) {
      return undefined;
    }

    const now = Date.now();
    const exclude = options.exclude;
    const allowRateLimitedFallback = options.allowRateLimitedFallback ?? false;
    const prefer = options.prefer;

    const notExcluded = (exclude?.size
      ? this.accounts.filter((a) => !exclude.has(a.configDir))
      : this.accounts
    ).filter((a) => !a.disabled);

    if (notExcluded.length === 0) {
      return undefined;
    }

    if (prefer) {
      const pinned = notExcluded.find(
        (a) => a.configDir === prefer && a.rateLimitUntil < now,
      );
      if (pinned) {
        pinned.lastUsed = now;
        return pinned.configDir;
      }
    }

    const availableAccounts = notExcluded.filter(
      (a) => a.rateLimitUntil < now,
    );

    let targetAccounts = availableAccounts;
    if (availableAccounts.length === 0) {
      if (!allowRateLimitedFallback) {
        return undefined;
      }
      // If all are rate limited, sort by who recovers first
      targetAccounts = [...notExcluded].sort(
        (a, b) => a.rateLimitUntil - b.rateLimitUntil,
      );
    }

    // Sort by active requests (ascending), then by last used (ascending for round-robin effect)
    const sorted = [...targetAccounts].sort((a, b) => {
      if (a.activeRequests !== b.activeRequests) {
        return a.activeRequests - b.activeRequests;
      }
      return a.lastUsed - b.lastUsed;
    });

    const selected = sorted[0];
    selected.lastUsed = now;
    return selected.configDir;
  }

  public reportRequestStart(configDir?: string): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account) {
      account.activeRequests++;
      account.totalRequests++;
    }
  }

  public reportRequestSuccess(configDir?: string, latencyMs = 0): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account) {
      account.totalSuccess++;
      account.totalLatencyMs += latencyMs;
    }
  }

  public reportRequestError(configDir?: string, latencyMs = 0): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account) {
      account.totalErrors++;
      account.totalLatencyMs += latencyMs;
    }
  }

  public reportRequestEnd(configDir?: string): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account && account.activeRequests > 0) {
      account.activeRequests--;
    }
  }

  public reportRateLimit(configDir?: string, penaltyMs: number = 60000): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account) {
      account.rateLimitUntil = Date.now() + penaltyMs;
      account.totalRateLimits++;
    }
  }

  public reportAccountDisabled(configDir?: string, reason?: string): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account) {
      account.disabled = true;
      account.disabledReason = reason ?? "";
      account.disabledAt = Date.now();
    }
  }

  public reportAccountEnabled(configDir?: string): void {
    if (!configDir) return;
    const account = this.accounts.find((a) => a.configDir === configDir);
    if (account) {
      account.disabled = false;
      account.disabledReason = "";
      account.disabledAt = 0;
    }
  }

  public getUsableCount(): number {
    return this.accounts.filter((a) => !a.disabled).length;
  }

  public getStats(): AccountStat[] {
    const now = Date.now();
    return this.accounts.map((a) => ({
      configDir: a.configDir,
      activeRequests: a.activeRequests,
      totalRequests: a.totalRequests,
      totalSuccess: a.totalSuccess,
      totalErrors: a.totalErrors,
      totalRateLimits: a.totalRateLimits,
      totalLatencyMs: a.totalLatencyMs,
      isRateLimited: a.rateLimitUntil > now,
      rateLimitUntil: a.rateLimitUntil,
      isDisabled: a.disabled,
      disabledReason: a.disabledReason,
      disabledAt: a.disabledAt,
    }));
  }

  public getConfigDirsCount(): number {
    return this.accounts.length;
  }
}

// Global instance to be initialized at server start
let globalPool: AccountPool | null = null;

export function initAccountPool(configDirs: string[]) {
  globalPool = new AccountPool(configDirs);
}

export function getNextAccountConfigDir(
  options?: GetNextConfigDirOptions,
): string | undefined {
  if (!globalPool) return undefined;
  return globalPool.getNextConfigDir(options);
}

export function reportRequestStart(configDir?: string): void {
  if (globalPool) {
    globalPool.reportRequestStart(configDir);
  }
}

export function reportRequestEnd(configDir?: string): void {
  if (globalPool) {
    globalPool.reportRequestEnd(configDir);
  }
}

export function reportRateLimit(configDir?: string, penaltyMs?: number): void {
  if (globalPool) {
    globalPool.reportRateLimit(configDir, penaltyMs);
  }
}

export function reportAccountDisabled(
  configDir?: string,
  reason?: string,
): void {
  if (globalPool) {
    globalPool.reportAccountDisabled(configDir, reason);
  }
}

export function reportAccountEnabled(configDir?: string): void {
  if (globalPool) {
    globalPool.reportAccountEnabled(configDir);
  }
}

export function getUsableCount(): number {
  return globalPool?.getUsableCount() ?? 0;
}

export function reportRequestSuccess(
  configDir?: string,
  latencyMs?: number,
): void {
  if (globalPool) {
    globalPool.reportRequestSuccess(configDir, latencyMs);
  }
}

export function reportRequestError(
  configDir?: string,
  latencyMs?: number,
): void {
  if (globalPool) {
    globalPool.reportRequestError(configDir, latencyMs);
  }
}

export function getAccountStats(): AccountStat[] {
  return globalPool?.getStats() ?? [];
}

export function getAccountPoolSize(): number {
  return globalPool?.getConfigDirsCount() ?? 0;
}
