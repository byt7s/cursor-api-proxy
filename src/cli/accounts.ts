import fs from "node:fs";
import path from "node:path";

import {
  hasAccountSessionAuth,
  readAccountApiKey,
  writeAccountApiKey,
} from "../lib/account-api-key.js";
import { ACCOUNTS_DIR } from "./constants.js";
import {
  readCachedToken,
  readKeychainToken,
  tokenSub,
  fetchAccountUsage,
  fetchApiKeyProfile,
  fetchStripeProfile,
  formatUsageSummary,
  describePlan,
  isSessionAccessToken,
  type ApiKeyProfile,
  type ModelUsage,
  type StripeProfile,
  type UsageData,
} from "./usage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccountInfo {
  name: string;
  configDir: string;
  authenticated: boolean;
  email?: string;
  displayName?: string;
  authId?: string;
  plan?: string;
  subscriptionStatus?: string;
  expiresAt?: string;
  /** How this account was authenticated. */
  authMethod?: "cli" | "api-key";
}

export type AccountUsageModel = ModelUsage & { id: string };

export type AccountUsagePayload = {
  startOfMonth: string | null;
  models: AccountUsageModel[];
};

export type AccountReport = {
  name: string;
  configDir: string;
  authenticated: boolean;
  authMethod: "cli" | "api-key" | null;
  /** True when `.cursor-api-key` is present (may coexist with a CLI session). */
  hasApiKey: boolean;
  email: string | null;
  displayName: string | null;
  /** Present for API-key accounts when `/v1/me` succeeds. */
  apiKeyName: string | null;
  /** ISO timestamp from `/v1/me` (API key creation), when available. */
  apiKeyCreatedAt: string | null;
  plan: string | null;
  membershipType: string | null;
  subscriptionStatus: string | null;
  expiresAt: string | null;
  usage: AccountUsagePayload | null;
  /**
   * Why plan/usage is missing. Key-only accounts cannot call Cursor billing
   * APIs (`api_key_unsupported`). Dual-cred accounts with a session JWT fetch
   * plan/usage from the session and still enrich key metadata via `/v1/me`.
   */
  usageError: string | null;
};

export type AccountsReport = {
  accounts: AccountReport[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reads authentication and plan metadata from a saved account directory.
 * Never throws — returns `authenticated: false` on any read/parse error.
 */
export function readAccountInfo(name: string, configDir: string): AccountInfo {
  const info: AccountInfo = { name, configDir, authenticated: false };
  const hasApiKey = Boolean(readAccountApiKey(configDir));
  const hasSession = hasAccountSessionAuth(configDir);

  // Session/login wins for authMethod when both credentials exist (dual-cred).
  if (hasSession) {
    info.authMethod = "cli";
  } else if (hasApiKey) {
    info.authMethod = "api-key";
  }

  const configFile = path.join(configDir, "cli-config.json");
  if (!fs.existsSync(configFile)) {
    if (info.authMethod === "api-key") {
      info.authenticated = true;
      info.email = `api-key@${name}`;
      info.displayName = `API key (${name})`;
      info.authId = `api-key:${name}`;
    }
    return info;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authMethod?: string;
      authInfo?: { email?: string; displayName?: string; authId?: string };
    };
    if (hasSession) {
      info.authMethod = "cli";
    } else if (raw.authMethod === "api-key" || hasApiKey) {
      info.authMethod = "api-key";
    } else if (raw.authInfo) {
      info.authMethod = "cli";
    }
    if (raw.authInfo && info.authMethod === "cli") {
      info.authenticated = true;
      info.email = raw.authInfo.email;
      info.displayName = raw.authInfo.displayName;
      info.authId = raw.authInfo.authId;
    } else if (raw.authInfo && info.authMethod === "api-key") {
      info.authenticated = true;
      info.email = raw.authInfo.email;
      info.displayName = raw.authInfo.displayName;
      info.authId = raw.authInfo.authId;
    } else if (info.authMethod === "api-key") {
      info.authenticated = true;
      info.email = `api-key@${name}`;
      info.displayName = `API key (${name})`;
      info.authId = `api-key:${name}`;
    }
  } catch {
    if (info.authMethod === "api-key") {
      info.authenticated = true;
      info.email = `api-key@${name}`;
      info.displayName = `API key (${name})`;
      info.authId = `api-key:${name}`;
    }
  }

  const statsigFile = path.join(configDir, "statsig-cache.json");
  if (!fs.existsSync(statsigFile)) return info;

  try {
    const statsigRaw = JSON.parse(fs.readFileSync(statsigFile, "utf-8")) as {
      data?: string;
    };
    if (!statsigRaw.data) return info;

    const statsig = JSON.parse(statsigRaw.data) as {
      user?: {
        custom?: {
          isEnterpriseUser?: boolean;
          stripeSubscriptionStatus?: string;
          stripeMembershipStatus?: string;
          stripeMembershipExpiration?: string;
        };
      };
    };

    const custom = statsig?.user?.custom;
    if (!custom) return info;

    if (custom.isEnterpriseUser) {
      info.plan = "Enterprise";
    } else if (custom.stripeSubscriptionStatus === "active") {
      info.plan = "Pro";
    } else {
      info.plan = "Free";
    }

    info.subscriptionStatus = custom.stripeSubscriptionStatus;

    if (custom.stripeMembershipExpiration) {
      info.expiresAt = new Date(
        custom.stripeMembershipExpiration,
      ).toLocaleDateString();
    }
  } catch {
    /* ignore */
  }

  return info;
}

function discoverAccountNames(accountsDir: string = ACCOUNTS_DIR): string[] {
  if (!fs.existsSync(accountsDir)) return [];
  return fs
    .readdirSync(accountsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
}

function resolveSessionToken(
  info: AccountInfo,
  keychainToken: string | undefined,
): string | undefined {
  const cachedToken = readCachedToken(info.configDir);
  if (cachedToken && isSessionAccessToken(cachedToken)) return cachedToken;

  const keychainMatchesAccount =
    !!keychainToken &&
    !!info.authId &&
    tokenSub(keychainToken) === info.authId;
  if (keychainMatchesAccount && keychainToken && isSessionAccessToken(keychainToken)) {
    return keychainToken;
  }
  return undefined;
}

async function loadLiveAccountData(
  info: AccountInfo,
  keychainToken: string | undefined,
): Promise<{
  liveProfile: StripeProfile | null;
  liveUsage: UsageData | null;
  apiKeyProfile: ApiKeyProfile | null;
  usageError: string | null;
}> {
  const apiKey = readAccountApiKey(info.configDir);
  const apiKeyForProfile =
    apiKey && !isSessionAccessToken(apiKey) ? apiKey : undefined;
  const apiKeyProfilePromise = apiKeyForProfile
    ? fetchApiKeyProfile(apiKeyForProfile)
    : Promise.resolve(null);

  // Dual-cred: prefer session JWT for plan/usage even when `.cursor-api-key` exists.
  const sessionToken = resolveSessionToken(info, keychainToken);
  if (sessionToken) {
    try {
      const [liveUsage, liveProfile, apiKeyProfile] = await Promise.all([
        fetchAccountUsage(sessionToken),
        fetchStripeProfile(sessionToken),
        apiKeyProfilePromise,
      ]);
      return {
        liveProfile,
        liveUsage,
        apiKeyProfile,
        usageError: liveUsage ? null : "usage_unavailable",
      };
    } catch {
      return {
        liveProfile: null,
        liveUsage: null,
        apiKeyProfile: await apiKeyProfilePromise,
        usageError: "fetch_failed",
      };
    }
  }

  // Key-only (no session JWT): enrich via /v1/me; billing APIs unavailable.
  if (apiKeyForProfile) {
    return {
      liveProfile: null,
      liveUsage: null,
      apiKeyProfile: await apiKeyProfilePromise,
      usageError: "api_key_unsupported",
    };
  }

  const cachedToken = readCachedToken(info.configDir);
  if (cachedToken && !isSessionAccessToken(cachedToken)) {
    const apiKeyProfile = await fetchApiKeyProfile(cachedToken);
    return {
      liveProfile: null,
      liveUsage: null,
      apiKeyProfile,
      usageError: "api_key_unsupported",
    };
  }

  return {
    liveProfile: null,
    liveUsage: null,
    apiKeyProfile: null,
    usageError: "no_token",
  };
}

function toUsagePayload(usage: UsageData): AccountUsagePayload {
  return {
    startOfMonth: usage.startOfMonth || null,
    models: Object.entries(usage.models).map(([id, row]) => ({
      id,
      ...row,
    })),
  };
}

function toAccountReport(
  info: AccountInfo,
  liveProfile: StripeProfile | null,
  liveUsage: UsageData | null,
  apiKeyProfile: ApiKeyProfile | null,
  usageError: string | null,
): AccountReport {
  const planFromLive = liveProfile ? describePlan(liveProfile) : null;
  const hasApiKey = Boolean(readAccountApiKey(info.configDir));
  // Session accounts keep login email; key-only prefer /v1/me when present.
  const email =
    info.authMethod === "cli"
      ? info.email || apiKeyProfile?.userEmail || null
      : apiKeyProfile?.userEmail || info.email || null;
  const displayName =
    info.authMethod === "cli"
      ? info.displayName ?? null
      : apiKeyProfile?.apiKeyName
        ? `API key (${apiKeyProfile.apiKeyName})`
        : info.displayName ?? null;
  return {
    name: info.name,
    configDir: info.configDir,
    authenticated: info.authenticated,
    authMethod: info.authMethod ?? null,
    hasApiKey,
    email,
    displayName,
    apiKeyName: apiKeyProfile?.apiKeyName ?? null,
    apiKeyCreatedAt: apiKeyProfile?.createdAt ?? null,
    plan: planFromLive ?? info.plan ?? null,
    membershipType: liveProfile?.membershipType ?? null,
    subscriptionStatus:
      liveProfile?.subscriptionStatus ?? info.subscriptionStatus ?? null,
    expiresAt: info.expiresAt ?? null,
    usage: liveUsage ? toUsagePayload(liveUsage) : null,
    usageError: liveUsage ? null : usageError,
  };
}

/**
 * Structured account report for GET /accounts (and CLI formatting).
 */
export async function buildAccountsReport(
  accountsDir: string = ACCOUNTS_DIR,
): Promise<AccountsReport> {
  const names = discoverAccountNames(accountsDir);
  const keychainToken = readKeychainToken();
  const accounts: AccountReport[] = [];

  for (const name of names) {
    const configDir = path.join(accountsDir, name);
    const info = readAccountInfo(name, configDir);
    if (!info.authenticated) {
      accounts.push(toAccountReport(info, null, null, null, null));
      continue;
    }
    const live = await loadLiveAccountData(info, keychainToken);
    accounts.push(
      toAccountReport(
        info,
        live.liveProfile,
        live.liveUsage,
        live.apiKeyProfile,
        live.usageError,
      ),
    );
  }

  return { accounts };
}

/** CLI-style text for `cursor-api-proxy accounts`. */
export function formatAccountsReportText(report: AccountsReport): string {
  if (report.accounts.length === 0) {
    return "No accounts found. Use 'cursor-api-proxy login' to add one.\n";
  }

  const out: string[] = ["🔑 Cursor Accounts:", ""];
  report.accounts.forEach((account, i) => {
    out.push(`  ${i + 1}. ${account.name}`);
    if (!account.authenticated) {
      out.push(`     ⚠️  Not authenticated`);
      out.push("");
      return;
    }
    if (account.email) {
      const display = account.displayName ? ` (${account.displayName})` : "";
      out.push(`     📧 ${account.email}${display}`);
    }
    if (account.authMethod === "api-key") {
      out.push(`     🔐 Auth: API key`);
    } else if (account.hasApiKey) {
      out.push(`     🔐 Auth: Cursor CLI + API key`);
    } else {
      out.push(`     🔐 Auth: Cursor CLI`);
    }
    if (account.apiKeyName) {
      out.push(`     🏷️  Key: ${account.apiKeyName}`);
    }
    if (account.apiKeyCreatedAt) {
      out.push(`     🗓️  Key created: ${account.apiKeyCreatedAt}`);
    }
    if (account.plan && !account.membershipType) {
      const canceled =
        account.subscriptionStatus === "canceled" ? " · canceled" : "";
      const expiry = account.expiresAt ? ` · expires ${account.expiresAt}` : "";
      out.push(`     📊 ${account.plan}${canceled}${expiry}`);
    }
    out.push(`     ✅ Authenticated`);
    if (account.membershipType && account.plan) {
      out.push(`     💳 ${account.plan}`);
    }
    if (account.usage) {
      for (const line of formatUsageSummary({
        startOfMonth: account.usage.startOfMonth ?? "",
        models: Object.fromEntries(
          account.usage.models.map(({ id, ...row }) => [id, row]),
        ),
      })) {
        out.push(line);
      }
    } else if (account.usageError === "api_key_unsupported") {
      out.push(`     ℹ️  Live usage unavailable for this API key`);
    }
    out.push("");
  });
  out.push("Tip: run 'cursor-api-proxy logout <name>' to remove an account.");
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function handleAccountsList(): Promise<void> {
  const report = await buildAccountsReport();
  const text = formatAccountsReportText(report);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

/**
 * Attach or replace a Dashboard API key on an existing account directory.
 * Preserves CLI session files so plan/usage keep using the session JWT.
 */
export function handleSetKey(accountName: string, apiKey: string): void {
  if (!accountName || !apiKey) {
    console.error(
      "❌ Error: Usage: cursor-api-proxy set-key <account-name> <api-key>",
    );
    process.exit(1);
  }

  if (!apiKey.startsWith("crsr_")) {
    console.error(
      "❌ Error: that does not look like a Dashboard API key (expected a 'crsr_' prefix).",
    );
    console.error("   Create one at Cursor Dashboard → Integrations.");
    process.exit(1);
  }

  const configDir = path.join(ACCOUNTS_DIR, accountName);
  if (!fs.existsSync(configDir)) {
    console.error(`❌ Account '${accountName}' not found.`);
    console.error(`   Run 'cursor-api-proxy login ${accountName}' first.`);
    process.exit(1);
  }

  writeAccountApiKey(configDir, apiKey);
  if (hasAccountSessionAuth(configDir)) {
    console.log(
      `✅ API key saved for '${accountName}' (CLI session preserved for usage/plan).`,
    );
  } else {
    console.log(`✅ API key saved for '${accountName}'.`);
  }
}

export async function handleLogout(accountName: string): Promise<void> {
  if (!accountName) {
    console.error("❌ Error: Please specify the account name to remove.");
    console.error("Usage: cursor-api-proxy logout <account-name>");
    process.exit(1);
  }

  const configDir = path.join(ACCOUNTS_DIR, accountName);

  if (!fs.existsSync(configDir)) {
    console.error(`❌ Account '${accountName}' not found.`);
    process.exit(1);
  }

  try {
    fs.rmSync(configDir, { recursive: true, force: true });
    console.log(`✅ Account '${accountName}' removed.`);
  } catch (err) {
    console.error(`❌ Error removing account:`, err);
    process.exit(1);
  }
}
