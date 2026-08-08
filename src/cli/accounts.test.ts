import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  writeAccountApiKey,
  writeApiKeyAccount,
} from "../lib/account-api-key.js";
import { TOKEN_FILE } from "../lib/token-cache.js";
import {
  buildAccountsReport,
  formatAccountsReportText,
} from "./accounts.js";
import * as usage from "./usage.js";

function fakeSessionJwt(sub = "auth0|user-1"): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("buildAccountsReport", () => {
  let tmp: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("enriches API-key accounts from /v1/me and keeps plan/usage null", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-list-"));
    writeApiKeyAccount(
      path.join(tmp, "byt7s@pm.me"),
      "byt7s@pm.me",
      "crsr_test_key_for_accounts_list",
    );

    vi.spyOn(usage, "fetchApiKeyProfile").mockResolvedValue({
      apiKeyName: "cursor-api-proxy",
      createdAt: "2026-08-08T05:05:01.564Z",
      userEmail: "byt7s@pm.me",
    });

    const report = await buildAccountsReport(tmp);
    expect(report).toEqual({
      accounts: [
        {
          name: "byt7s@pm.me",
          configDir: path.join(tmp, "byt7s@pm.me"),
          authenticated: true,
          authMethod: "api-key",
          hasApiKey: true,
          email: "byt7s@pm.me",
          displayName: "API key (cursor-api-proxy)",
          apiKeyName: "cursor-api-proxy",
          apiKeyCreatedAt: "2026-08-08T05:05:01.564Z",
          plan: null,
          membershipType: null,
          subscriptionStatus: null,
          expiresAt: null,
          usage: null,
          usageError: "api_key_unsupported",
        },
      ],
    });
  });

  it("prefers session usage/plan when API key coexists (dual-cred)", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-dual-"));
    const configDir = path.join(tmp, "work");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "cli-config.json"),
      JSON.stringify({
        authMethod: "cli",
        authInfo: {
          email: "work@example.com",
          displayName: "Work",
          authId: "auth0|user-1",
        },
      }),
    );
    fs.writeFileSync(path.join(configDir, TOKEN_FILE), fakeSessionJwt(), {
      mode: 0o600,
    });
    writeAccountApiKey(configDir, "crsr_dual_cred_key");

    const fetchKey = vi.spyOn(usage, "fetchApiKeyProfile").mockResolvedValue({
      apiKeyName: "sdk-key",
      createdAt: "2026-08-08T05:05:01.564Z",
      userEmail: "work@example.com",
    });
    const fetchUsage = vi.spyOn(usage, "fetchAccountUsage").mockResolvedValue({
      startOfMonth: "2026-08-01",
      models: {
        "gpt-4": {
          numRequests: 3,
          numRequestsTotal: 3,
          numTokens: 100,
          maxRequestUsage: 500,
          maxTokenUsage: null,
        },
      },
    });
    vi.spyOn(usage, "fetchStripeProfile").mockResolvedValue({
      membershipType: "pro",
      subscriptionStatus: "active",
      daysRemainingOnTrial: null,
      isTeamMember: false,
      isYearlyPlan: false,
    });

    const report = await buildAccountsReport(tmp);
    expect(report.accounts).toHaveLength(1);
    const account = report.accounts[0]!;
    expect(account.authMethod).toBe("cli");
    expect(account.hasApiKey).toBe(true);
    expect(account.email).toBe("work@example.com");
    expect(account.displayName).toBe("Work");
    expect(account.apiKeyName).toBe("sdk-key");
    expect(account.membershipType).toBe("pro");
    expect(account.usageError).toBeNull();
    expect(account.usage?.models[0]?.numRequests).toBe(3);
    expect(fetchUsage).toHaveBeenCalledOnce();
    expect(fetchKey).toHaveBeenCalledWith("crsr_dual_cred_key");
  });

  it("returns empty accounts array when none exist", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-empty-"));
    const report = await buildAccountsReport(tmp);
    expect(report).toEqual({ accounts: [] });
  });

  it("formats CLI text from the structured report", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-cli-"));
    writeApiKeyAccount(
      path.join(tmp, "byt7s@pm.me"),
      "byt7s@pm.me",
      "crsr_test_key_for_accounts_list",
    );
    vi.spyOn(usage, "fetchApiKeyProfile").mockResolvedValue({
      apiKeyName: "cursor-api-proxy",
      createdAt: "2026-08-08T05:05:01.564Z",
      userEmail: "byt7s@pm.me",
    });
    const text = formatAccountsReportText(await buildAccountsReport(tmp));
    expect(text).toContain("🔑 Cursor Accounts:");
    expect(text).toContain("1. byt7s@pm.me");
    expect(text).toContain("🔐 Auth: API key");
    expect(text).toContain("🏷️  Key: cursor-api-proxy");
    expect(text).toContain("Live usage unavailable for this API key");
  });

  it("formats dual-cred CLI text with session + API key", async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-dual-cli-"));
    const configDir = path.join(tmp, "work");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "cli-config.json"),
      JSON.stringify({
        authInfo: {
          email: "work@example.com",
          displayName: "Work",
          authId: "auth0|user-1",
        },
      }),
    );
    fs.writeFileSync(path.join(configDir, TOKEN_FILE), fakeSessionJwt(), {
      mode: 0o600,
    });
    writeAccountApiKey(configDir, "crsr_dual_cred_key");
    vi.spyOn(usage, "fetchApiKeyProfile").mockResolvedValue({
      apiKeyName: "sdk-key",
      createdAt: "2026-08-08T05:05:01.564Z",
      userEmail: "work@example.com",
    });
    vi.spyOn(usage, "fetchAccountUsage").mockResolvedValue({
      startOfMonth: "2026-08-01",
      models: {},
    });
    vi.spyOn(usage, "fetchStripeProfile").mockResolvedValue({
      membershipType: "pro",
      subscriptionStatus: "active",
      daysRemainingOnTrial: null,
      isTeamMember: false,
      isYearlyPlan: false,
    });

    const text = formatAccountsReportText(await buildAccountsReport(tmp));
    expect(text).toContain("🔐 Auth: Cursor CLI + API key");
    expect(text).toContain("🏷️  Key: sdk-key");
  });
});
