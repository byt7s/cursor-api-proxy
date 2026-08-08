import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadBridgeConfig } from "./config.js";
import { API_KEY_FILE, runDoctor } from "./doctor.js";

const created: string[] = [];

function accountDir(opts: {
  withKey?: boolean;
  withSession?: boolean;
}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-doctor-acc-"));
  created.push(dir);
  if (opts.withKey) {
    fs.writeFileSync(path.join(dir, API_KEY_FILE), "crsr_test");
  }
  if (opts.withSession) {
    fs.writeFileSync(
      path.join(dir, "cli-config.json"),
      JSON.stringify({ authInfo: { email: "user@example.com" } }),
    );
  }
  return dir;
}

function testConfig(overrides: Parameters<typeof loadBridgeConfig>[0] = {}) {
  return loadBridgeConfig({
    env: {
      CURSOR_AGENT_BIN: process.execPath,
      CURSOR_BRIDGE_DEFAULT_MODEL: "composer-2.5",
      ...(overrides?.env ?? {}),
    },
    cwd: overrides?.cwd,
  });
}

afterEach(() => {
  while (created.length) {
    fs.rmSync(created.pop()!, { recursive: true, force: true });
  }
});

describe("runDoctor", () => {
  it("reports a missing account dir as failure", () => {
    const missing = path.join(
      os.tmpdir(),
      `cursor-doctor-missing-${Date.now()}`,
    );
    const config = testConfig();
    config.configDirs = [missing];

    const result = runDoctor(config, {});

    expect(result.ok).toBe(false);
    expect(
      result.checks.some((c) => c.name.startsWith("accountDir:") && !c.ok),
    ).toBe(true);
  });

  it("fails an account that exists but has no credentials", () => {
    const dir = accountDir({});
    const config = testConfig();
    config.configDirs = [dir];

    const result = runDoctor(config, {});

    const check = result.checks.find((c) => c.name.startsWith("accountDir:"));
    expect(check?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("passes when the account dir carries an API key", () => {
    const dir = accountDir({ withKey: true });
    const config = testConfig();
    config.configDirs = [dir];

    const result = runDoctor(config, {});

    expect(result.checks.find((c) => c.name.startsWith("accountDir:"))?.ok).toBe(
      true,
    );
    expect(result.checks.find((c) => c.name === "agentCommand")?.ok).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("passes when the account dir has a session login", () => {
    const dir = accountDir({ withSession: true });
    const config = testConfig();
    config.configDirs = [dir];

    const result = runDoctor(config, {});

    expect(result.checks.find((c) => c.name.startsWith("accountDir:"))?.ok).toBe(
      true,
    );
    expect(result.ok).toBe(true);
  });

  it("accepts a keyless setup when CURSOR_API_KEY is in the environment", () => {
    const config = testConfig();
    config.configDirs = [];

    const result = runDoctor(config, { CURSOR_API_KEY: "crsr_env" });

    expect(result.checks.find((c) => c.name === "accountDirs")?.ok).toBe(true);
  });

  it("fails an empty defaultModel", () => {
    const config = testConfig();
    config.defaultModel = "";
    config.configDirs = [accountDir({ withKey: true })];

    const result = runDoctor(config, {});

    expect(result.checks.find((c) => c.name === "defaultModel")?.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});
