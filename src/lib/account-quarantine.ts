import path from "node:path";
import {
  getAccountPoolSize,
  getAccountStats,
  getUsableCount,
  reportAccountDisabled,
} from "./account-pool.js";
import {
  shouldDisableForPlanUpgrade,
  type AccountFailureKind,
} from "./account-failure.js";

export const NO_USABLE_ACCOUNTS_ERROR = {
  message: "No usable Cursor accounts (all disabled)",
  code: "no_usable_accounts",
} as const;

/** True when a non-empty account pool has no selectable account. */
export function isAllAccountsDisabled(
  configDir: string | undefined,
): boolean {
  return configDir === undefined && getAccountPoolSize() > 0 && getUsableCount() === 0;
}

export function describeNoUsableAccounts(): {
  message: string;
  code: string;
} {
  return { ...NO_USABLE_ACCOUNTS_ERROR };
}

export function quarantineAccount(
  configDir: string | undefined,
  reason: string,
): void {
  if (!configDir) return;
  reportAccountDisabled(configDir, reason);
  const stats = getAccountStats();
  const account = stats.find((s) => s.configDir === configDir);
  const disabledCount = stats.filter((s) => s.isDisabled).length;
  const totalCount = stats.length;
  const usableCount = getUsableCount();
  const disabledAt = account?.disabledAt ?? Date.now();
  console.warn(
    `[account-quarantine] disabled account=${path.basename(configDir)} reason=${reason} disabledAt=${disabledAt} usable=${usableCount} disabled=${disabledCount} total=${totalCount}`,
  );
}

/**
 * Inspect an agent attempt for plan-upgrade signals and permanently disable
 * the account when the response is essentially only that notice.
 */
export function applyPlanUpgradeQuarantine(
  configDir: string | undefined,
  result: {
    code: number;
    stdout?: string;
    stderr?: string;
  },
): AccountFailureKind | "other" {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";

  if (
    shouldDisableForPlanUpgrade({
      text: stderr,
      exitCode: result.code,
      fromErrorChannel: true,
    })
  ) {
    quarantineAccount(configDir, "upgrade_plan");
    return "plan_upgrade";
  }

  if (
    shouldDisableForPlanUpgrade({
      text: stdout,
      exitCode: result.code,
      fromErrorChannel: false,
    })
  ) {
    quarantineAccount(configDir, "upgrade_plan");
    return "plan_upgrade";
  }

  return "other";
}
