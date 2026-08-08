import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONFIG_FILE_KEYS,
  ConfigFileError,
  REFUSED_CONFIG_KEYS,
  computeConfigSources,
  configFileEnvOverlay,
  readConfigFile,
  resolveConfigFilePath,
  validateConfigFileValues,
  writeConfigFile,
} from "./config-file.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-file-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(contents: unknown): string {
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    typeof contents === "string" ? contents : JSON.stringify(contents),
  );
  return file;
}

describe("resolveConfigFilePath", () => {
  it("prefers an explicit path, resolved against the cwd", () => {
    expect(resolveConfigFilePath("cfg.json", "/home/me", "/work")).toBe(
      path.resolve("/work", "cfg.json"),
    );
  });

  it("defaults to the storage directory under HOME", () => {
    expect(resolveConfigFilePath(undefined, "/home/me", "/work")).toBe(
      path.join("/home/me", ".cursor-api-proxy", "config.json"),
    );
  });

  it("falls back to the cwd when there is no home directory", () => {
    expect(resolveConfigFilePath(undefined, undefined, "/work")).toBe(
      path.join("/work", "cursor-api-proxy.config.json"),
    );
  });
});

describe("readConfigFile", () => {
  it("reports a missing file as empty rather than failing", () => {
    const parsed = readConfigFile(path.join(dir, "absent.json"));
    expect(parsed.exists).toBe(false);
    expect(parsed.values).toEqual({});
    expect(parsed.warnings).toEqual([]);
  });

  it("parses documented keys", () => {
    const parsed = readConfigFile(
      write({ port: 9000, defaultModel: "auto", toolCalls: true }),
    );
    expect(parsed.exists).toBe(true);
    expect(parsed.values).toEqual({
      port: 9000,
      defaultModel: "auto",
      toolCalls: true,
    });
  });

  it("warns about an unknown key instead of crashing", () => {
    const parsed = readConfigFile(write({ port: 9000, nope: 1 }));
    expect(parsed.values).toEqual({ port: 9000 });
    expect(parsed.warnings.join(" ")).toContain('unknown key "nope"');
  });

  it("names the key when a value has the wrong type", () => {
    expect(() => readConfigFile(write({ port: "9000" }))).toThrowError(
      /"port" must be a finite number/,
    );
  });

  it("names the key when an enum value is not allowed", () => {
    expect(() => readConfigFile(write({ mode: "nope" }))).toThrowError(
      /"mode" must be one of agent, ask, plan/,
    );
  });

  it("refuses credentials loudly", () => {
    expect(() => readConfigFile(write({ apiKey: "sk-secret" }))).toThrowError(
      /"apiKey" is not allowed/,
    );
    // The message must never echo the value it refused.
    try {
      readConfigFile(write({ dashboardKey: "sk-secret" }));
    } catch (err) {
      expect(String(err)).not.toContain("sk-secret");
    }
  });

  it("reports invalid JSON with the path", () => {
    const file = write("{ not json");
    expect(() => readConfigFile(file)).toThrowError(/is not valid JSON/);
  });

  it("rejects a non-object document", () => {
    expect(() => readConfigFile(write([1, 2]))).toThrowError(
      /must contain a JSON object/,
    );
  });
});

describe("validateConfigFileValues", () => {
  it("accepts string arrays and rejects mixed ones", () => {
    expect(validateConfigFileValues({ corsOrigins: ["a", "b"] }).values).toEqual({
      corsOrigins: ["a", "b"],
    });
    expect(() => validateConfigFileValues({ corsOrigins: ["a", 2] })).toThrowError(
      /"corsOrigins" must be an array of strings/,
    );
  });

  it("treats null as absent so a key can be blanked", () => {
    expect(validateConfigFileValues({ port: null }).values).toEqual({});
  });
});

describe("configFileEnvOverlay", () => {
  it("serializes each value the way its variable expects", () => {
    expect(
      configFileEnvOverlay({
        port: 9000,
        toolCalls: true,
        metricsEnabled: false,
        corsOrigins: ["https://a.example", "https://b.example"],
      }),
    ).toEqual({
      CURSOR_BRIDGE_PORT: "9000",
      CURSOR_BRIDGE_TOOL_CALLS: "true",
      CURSOR_BRIDGE_METRICS_ENABLED: "false",
      CURSOR_BRIDGE_CORS_ORIGINS: "https://a.example,https://b.example",
    });
  });
});

describe("computeConfigSources", () => {
  it("ranks cli over env over file over default", () => {
    const sources = computeConfigSources(
      { CURSOR_BRIDGE_PORT: "9000" },
      { port: 1234, defaultModel: "auto" },
      ["verbose"],
    );
    expect(sources.port).toBe("env");
    expect(sources.defaultModel).toBe("file");
    expect(sources.verbose).toBe("cli");
    expect(sources.timeoutMs).toBe("default");
  });

  it("ignores an empty environment variable", () => {
    const sources = computeConfigSources({ CURSOR_BRIDGE_PORT: "  " }, { port: 1 });
    expect(sources.port).toBe("file");
  });
});

describe("writeConfigFile", () => {
  it("writes atomically and leaves no temp file behind", () => {
    const file = path.join(dir, "config.json");
    const result = writeConfigFile(file, { port: 9000 });
    expect(result.written).toEqual(["port"]);
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ port: 9000 });
    expect(fs.readdirSync(dir)).toEqual(["config.json"]);
  });

  it("creates the storage directory when it is missing", () => {
    const file = path.join(dir, "nested", "deeper", "config.json");
    writeConfigFile(file, { port: 9000 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it("validates before persisting, so a bad write cannot corrupt the file", () => {
    const file = path.join(dir, "config.json");
    writeConfigFile(file, { port: 9000 });
    expect(() => writeConfigFile(file, { port: "nine" })).toThrowError(
      /"port" must be a finite number/,
    );
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ port: 9000 });
  });

  it("refuses credential keys", () => {
    expect(() =>
      writeConfigFile(path.join(dir, "config.json"), { apiKeys: "x" }),
    ).toThrowError(/"apiKeys" is not allowed/);
  });

  it("refuses keys the dashboard may not own", () => {
    expect(() =>
      writeConfigFile(path.join(dir, "config.json"), { tlsCertPath: "/tmp/x" }),
    ).toThrowError(/"tlsCertPath" is read-only from the dashboard/);
  });

  it("reports only genuinely changed values as needing a restart", () => {
    const file = path.join(dir, "config.json");
    const result = writeConfigFile(
      file,
      { port: 9000, defaultModel: "auto" },
      { port: 9000, defaultModel: "gpt-5" },
      { effective: { port: 9000, defaultModel: "gpt-5" }, sources: {} },
    );
    expect(result.restartRequired).toEqual(["defaultModel"]);
    expect(result.noEffect).toEqual([]);
  });

  it("flags a saved value the environment still overrides", () => {
    const result = writeConfigFile(
      path.join(dir, "config.json"),
      { port: 9000 },
      {},
      { effective: { port: 8765 }, sources: { port: "env" } },
    );
    expect(result.restartRequired).toEqual([]);
    expect(result.noEffect).toEqual(["port"]);
  });

  it("keeps unknown-key warnings out of the persisted file", () => {
    const file = path.join(dir, "config.json");
    const result = writeConfigFile(file, { port: 9000, nope: true });
    expect(result.warnings.join(" ")).toContain('unknown key "nope"');
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ port: 9000 });
  });
});

describe("the key table", () => {
  it("maps every key to a distinct environment variable", () => {
    const keys = CONFIG_FILE_KEYS.map((spec) => spec.key);
    const envs = CONFIG_FILE_KEYS.map((spec) => spec.env);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(envs).size).toBe(envs.length);
  });

  it("never documents a refused key as settable", () => {
    for (const refused of REFUSED_CONFIG_KEYS) {
      expect(CONFIG_FILE_KEYS.some((spec) => spec.key === refused)).toBe(false);
    }
  });

  it("gives every enum key its allowed values", () => {
    for (const spec of CONFIG_FILE_KEYS) {
      if (spec.type === "enum") expect(spec.values?.length).toBeGreaterThan(0);
    }
  });
});
