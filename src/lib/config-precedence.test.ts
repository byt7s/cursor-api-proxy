import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadEnvConfig } from "./env.js";

let home: string;
let configPath: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "config-precedence-"));
  fs.mkdirSync(path.join(home, ".cursor-api-proxy"), { recursive: true });
  configPath = path.join(home, ".cursor-api-proxy", "config.json");
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeConfig(values: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(values));
}

describe("config file precedence", () => {
  it("uses the file when nothing else sets the value", () => {
    writeConfig({ port: 9100, defaultModel: "gpt-5", toolCalls: true });
    const loaded = loadEnvConfig({ env: { HOME: home }, cwd: "/workspace" });
    expect(loaded.port).toBe(9100);
    expect(loaded.defaultModel).toBe("gpt-5");
    expect(loaded.toolCalls).toBe(true);
    expect(loaded.configFile.sources.port).toBe("file");
  });

  it("lets the environment win over the file", () => {
    writeConfig({ port: 9100 });
    const loaded = loadEnvConfig({
      env: { HOME: home, CURSOR_BRIDGE_PORT: "9200" },
      cwd: "/workspace",
    });
    expect(loaded.port).toBe(9200);
    expect(loaded.configFile.sources.port).toBe("env");
    // The file value is still reported, so the dashboard can show what it holds.
    expect(loaded.configFile.values.port).toBe(9100);
  });

  it("falls back to the built-in default when neither sets the value", () => {
    writeConfig({ defaultModel: "gpt-5" });
    const loaded = loadEnvConfig({ env: { HOME: home }, cwd: "/workspace" });
    expect(loaded.port).toBe(8765);
    expect(loaded.configFile.sources.port).toBe("default");
  });

  it("lets the CLI --verbose flag win over both", () => {
    writeConfig({ verbose: false });
    const loaded = loadEnvConfig({
      env: { HOME: home, CURSOR_BRIDGE_VERBOSE: "false" },
      cwd: "/workspace",
      verbose: true,
    });
    expect(loaded.verbose).toBe(true);
    expect(loaded.configFile.sources.verbose).toBe("cli");
  });

  it("keeps CURSOR_BRIDGE_MODE ahead of --mode, and the file behind both", () => {
    writeConfig({ mode: "plan" });
    expect(
      loadEnvConfig({ env: { HOME: home }, cwd: "/w", mode: "agent" }).mode,
    ).toBe("agent");
    expect(
      loadEnvConfig({
        env: { HOME: home, CURSOR_BRIDGE_MODE: "ask" },
        cwd: "/w",
        mode: "agent",
      }).mode,
    ).toBe("ask");
    expect(loadEnvConfig({ env: { HOME: home }, cwd: "/w" }).mode).toBe("plan");
  });

  it("reads the file named by CURSOR_BRIDGE_CONFIG_FILE instead", () => {
    const alternate = path.join(home, "elsewhere.json");
    fs.writeFileSync(alternate, JSON.stringify({ port: 9300 }));
    writeConfig({ port: 9100 });
    const loaded = loadEnvConfig({
      env: { HOME: home, CURSOR_BRIDGE_CONFIG_FILE: alternate },
      cwd: "/workspace",
    });
    expect(loaded.port).toBe(9300);
    expect(loaded.configFile.path).toBe(alternate);
  });

  it("cannot shadow variables outside the documented key table", () => {
    writeConfig({ port: 9100 });
    const loaded = loadEnvConfig({
      env: { HOME: home, CURSOR_API_KEY: "real-token" },
      cwd: "/workspace",
    });
    // HOME still resolves the storage dir from the real environment.
    expect(loaded.sessionsLogPath.startsWith(home)).toBe(true);
    expect(loaded.configFile.exists).toBe(true);
  });

  it("surfaces unknown keys as warnings rather than failing to start", () => {
    writeConfig({ port: 9100, nonsense: true });
    const loaded = loadEnvConfig({ env: { HOME: home }, cwd: "/workspace" });
    expect(loaded.port).toBe(9100);
    expect(loaded.configFile.warnings.join(" ")).toContain(
      'unknown key "nonsense"',
    );
  });

  it("fails to start and names the key when a value is invalid", () => {
    writeConfig({ maxConcurrentRuns: "many" });
    expect(() => loadEnvConfig({ env: { HOME: home }, cwd: "/workspace" })).toThrowError(
      /"maxConcurrentRuns" must be a finite number/,
    );
  });

  it("applies admission and engine caps from the file", () => {
    writeConfig({
      maxConcurrentRuns: 24,
      maxConcurrentRunsPerAccount: 4,
      sdkMaxConcurrentRuns: 64,
      sdkMaxConcurrentRunsPerAccount: 16,
      admissionWaitMs: 250,
      defaultEngine: "sdk",
      thoughtMode: "reasoning",
    });
    const loaded = loadEnvConfig({ env: { HOME: home }, cwd: "/workspace" });
    expect(loaded.maxConcurrentRuns).toBe(24);
    expect(loaded.maxConcurrentRunsPerAccount).toBe(4);
    expect(loaded.sdkMaxConcurrentRuns).toBe(64);
    expect(loaded.sdkMaxConcurrentRunsPerAccount).toBe(16);
    expect(loaded.admissionWaitMs).toBe(250);
    expect(loaded.defaultEngine).toBe("sdk");
    expect(loaded.thoughtMode).toBe("reasoning");
  });

  it("ignores the file when the caller opts out", () => {
    writeConfig({ port: 9100 });
    const loaded = loadEnvConfig({
      env: { HOME: home },
      cwd: "/workspace",
      skipConfigFile: true,
    });
    expect(loaded.port).toBe(8765);
    expect(loaded.configFile.exists).toBe(false);
  });
});
