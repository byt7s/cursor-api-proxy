import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { writeApiKeyAccount } from "../lib/account-api-key.js";
import {
  buildAccountsReport,
  formatAccountsReportText,
} from "./accounts.js";
import * as usage from "./usage.js";

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
});
