/**
 * Optional `~/.cursor-api-proxy/config.json`.
 *
 * The proxy has always been configured through `CURSOR_BRIDGE_*` variables,
 * which is awkward for a long-lived local service: the settings live in
 * whatever shell or plist started it. The config file is a persistent layer
 * *below* the environment, so nothing about an existing setup changes:
 *
 *     CLI flags  >  environment  >  config file  >  built-in defaults
 *
 * Rather than teaching every consumer about a second source, the file is
 * translated into an env-shaped overlay that `loadEnvConfig` consults only
 * where the real environment is silent. Every parser, alias and default in
 * `env.ts` therefore keeps working untouched, and the file mirrors the env
 * names in camelCase (`defaultModel` ↔ `CURSOR_BRIDGE_DEFAULT_MODEL`).
 *
 * Secrets are deliberately not part of this: API keys stay in the environment
 * where process isolation protects them, and `PUT /api/config/file` refuses
 * them outright.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export type ConfigValueSource = "cli" | "env" | "file" | "default";

export type ConfigFileType =
  | "string"
  | "number"
  | "boolean"
  | "string[]"
  | "enum"
  /** JSON object (e.g. model alias map). Serialized to env as a JSON string. */
  | "object";

export type ConfigFileKeySpec = {
  /** camelCase key as it appears in config.json. */
  key: string;
  /** Environment variable this key mirrors. */
  env: string;
  type: ConfigFileType;
  /** Allowed values when `type` is `enum`. */
  values?: string[];
  /** Grouping used by the dashboard form. */
  group: string;
  label: string;
  /** False → the file may set it, but the dashboard refuses to write it. */
  editable: boolean;
};

/**
 * Every key the file understands. Anything absent from this table is an
 * unknown key: it warns, it is ignored, and it is never written back.
 */
export const CONFIG_FILE_KEYS: ConfigFileKeySpec[] = [
  { key: "host", env: "CURSOR_BRIDGE_HOST", type: "string", group: "Server", label: "Bind address", editable: true },
  { key: "port", env: "CURSOR_BRIDGE_PORT", type: "number", group: "Server", label: "Port", editable: true },
  { key: "multiPort", env: "CURSOR_BRIDGE_MULTI_PORT", type: "boolean", group: "Server", label: "One port per account", editable: true },
  { key: "timeoutMs", env: "CURSOR_BRIDGE_TIMEOUT_MS", type: "number", group: "Server", label: "Completion timeout (ms)", editable: true },
  { key: "tlsCertPath", env: "CURSOR_BRIDGE_TLS_CERT", type: "string", group: "Server", label: "TLS certificate", editable: false },
  { key: "tlsKeyPath", env: "CURSOR_BRIDGE_TLS_KEY", type: "string", group: "Server", label: "TLS private key", editable: false },

  { key: "defaultModel", env: "CURSOR_BRIDGE_DEFAULT_MODEL", type: "string", group: "Models", label: "Default model", editable: true },
  { key: "strictModel", env: "CURSOR_BRIDGE_STRICT_MODEL", type: "boolean", group: "Models", label: "Strict model", editable: true },
  { key: "modelAliases", env: "CURSOR_BRIDGE_MODEL_ALIASES", type: "object", group: "Models", label: "Model aliases", editable: true },
  { key: "mode", env: "CURSOR_BRIDGE_MODE", type: "enum", values: ["agent", "ask", "plan"], group: "Models", label: "Default mode", editable: true },
  { key: "maxMode", env: "CURSOR_BRIDGE_MAX_MODE", type: "boolean", group: "Models", label: "Max mode", editable: true },
  { key: "force", env: "CURSOR_BRIDGE_FORCE", type: "boolean", group: "Models", label: "Force", editable: true },
  { key: "thoughtMode", env: "CURSOR_BRIDGE_THOUGHT_MODE", type: "enum", values: ["drop", "reasoning"], group: "Models", label: "Thought channel", editable: true },
  { key: "toolCalls", env: "CURSOR_BRIDGE_TOOL_CALLS", type: "boolean", group: "Models", label: "Bridge tool calls", editable: true },

  { key: "workspace", env: "CURSOR_BRIDGE_WORKSPACE", type: "string", group: "Workspace", label: "Workspace root", editable: true },
  { key: "chatOnlyWorkspace", env: "CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE", type: "boolean", group: "Workspace", label: "Chat-only workspace", editable: true },
  { key: "contextPreamble", env: "CURSOR_BRIDGE_CONTEXT_PREAMBLE", type: "boolean", group: "Workspace", label: "Context preamble", editable: true },
  { key: "contextExtra", env: "CURSOR_BRIDGE_CONTEXT_EXTRA", type: "string", group: "Workspace", label: "Extra context", editable: true },

  { key: "agentBin", env: "CURSOR_AGENT_BIN", type: "string", group: "Engines", label: "Agent binary", editable: true },
  { key: "useAcp", env: "CURSOR_BRIDGE_USE_ACP", type: "boolean", group: "Engines", label: "Use ACP", editable: true },
  { key: "defaultEngine", env: "CURSOR_BRIDGE_DEFAULT_ENGINE", type: "enum", values: ["acp", "sdk"], group: "Engines", label: "Default engine", editable: true },
  { key: "approveMcps", env: "CURSOR_BRIDGE_APPROVE_MCPS", type: "boolean", group: "Engines", label: "Approve MCPs", editable: true },
  { key: "promptViaStdin", env: "CURSOR_BRIDGE_PROMPT_VIA_STDIN", type: "boolean", group: "Engines", label: "Prompt via stdin", editable: true },
  { key: "winCmdlineMax", env: "CURSOR_BRIDGE_WIN_CMDLINE_MAX", type: "number", group: "Engines", label: "Windows cmdline budget", editable: true },
  { key: "configDirs", env: "CURSOR_CONFIG_DIRS", type: "string[]", group: "Engines", label: "Account directories", editable: false },

  { key: "maxConcurrentRuns", env: "CURSOR_BRIDGE_MAX_CONCURRENT_RUNS", type: "number", group: "Admission", label: "ACP global cap", editable: true },
  { key: "maxConcurrentRunsPerAccount", env: "CURSOR_BRIDGE_MAX_CONCURRENT_RUNS_PER_ACCOUNT", type: "number", group: "Admission", label: "ACP per-account cap", editable: true },
  { key: "sdkMaxConcurrentRuns", env: "CURSOR_BRIDGE_MAX_CONCURRENT_RUNS_SDK", type: "number", group: "Admission", label: "SDK global cap", editable: true },
  { key: "sdkMaxConcurrentRunsPerAccount", env: "CURSOR_BRIDGE_MAX_CONCURRENT_RUNS_PER_ACCOUNT_SDK", type: "number", group: "Admission", label: "SDK per-account cap", editable: true },
  { key: "admissionWaitMs", env: "CURSOR_BRIDGE_ADMISSION_WAIT_MS", type: "number", group: "Admission", label: "Admission wait (ms)", editable: true },

  { key: "verbose", env: "CURSOR_BRIDGE_VERBOSE", type: "boolean", group: "Observability", label: "Verbose logs", editable: true },
  { key: "sessionsLogPath", env: "CURSOR_BRIDGE_SESSIONS_LOG", type: "string", group: "Observability", label: "Sessions log", editable: true },
  { key: "requestsLogPath", env: "CURSOR_BRIDGE_REQUESTS_LOG", type: "string", group: "Observability", label: "Requests log (JSONL)", editable: true },
  { key: "requestsLogEnabled", env: "CURSOR_BRIDGE_REQUESTS_LOG_ENABLED", type: "boolean", group: "Observability", label: "Requests log enabled", editable: true },
  { key: "requestsLogMaxBytes", env: "CURSOR_BRIDGE_REQUESTS_LOG_MAX_BYTES", type: "number", group: "Observability", label: "Requests log rotate at", editable: true },
  { key: "metricsEnabled", env: "CURSOR_BRIDGE_METRICS_ENABLED", type: "boolean", group: "Observability", label: "Serve /metrics", editable: true },
  { key: "latencyWaterfall", env: "CURSOR_BRIDGE_LATENCY_WATERFALL", type: "boolean", group: "Observability", label: "Latency waterfall log", editable: true },

  { key: "keyRateLimitPerMin", env: "CURSOR_BRIDGE_KEY_RATE_LIMIT_PER_MIN", type: "number", group: "Security", label: "Per-key rate limit", editable: true },
  { key: "auditLogPath", env: "CURSOR_BRIDGE_AUDIT_LOG", type: "string", group: "Security", label: "Audit log", editable: true },
  { key: "auditLogEnabled", env: "CURSOR_BRIDGE_AUDIT_LOG_ENABLED", type: "boolean", group: "Security", label: "Audit log enabled", editable: true },
  { key: "auditLogMaxBytes", env: "CURSOR_BRIDGE_AUDIT_LOG_MAX_BYTES", type: "number", group: "Security", label: "Audit log rotate at", editable: true },
  { key: "maxBodyBytes", env: "CURSOR_BRIDGE_MAX_BODY_BYTES", type: "number", group: "Security", label: "Max JSON body", editable: true },
  { key: "corsOrigins", env: "CURSOR_BRIDGE_CORS_ORIGINS", type: "string[]", group: "Security", label: "CORS origins", editable: true },
];

const SPEC_BY_KEY = new Map(CONFIG_FILE_KEYS.map((spec) => [spec.key, spec]));

/**
 * Credentials the file must never own. They are rejected loudly rather than
 * ignored, so nobody believes they configured auth by editing a JSON file.
 */
export const REFUSED_CONFIG_KEYS = [
  "apiKey",
  "apiKeys",
  "bridgeApiKey",
  "requiredKey",
  "dashboardKey",
  "cursorApiKey",
  "cursorAuthToken",
];

export type ConfigFileValues = Record<
  string,
  string | number | boolean | string[] | Record<string, string>
>;

/** Thrown for a value the file cannot mean; the message always names the key. */
export class ConfigFileError extends Error {
  readonly key?: string;

  constructor(message: string, key?: string) {
    super(message);
    this.name = "ConfigFileError";
    this.key = key;
  }
}

export function configFileSpec(key: string): ConfigFileKeySpec | undefined {
  return SPEC_BY_KEY.get(key);
}

export function resolveConfigFilePath(
  explicit: string | undefined,
  home: string | undefined,
  cwd: string,
): string {
  if (explicit) return path.resolve(cwd, explicit);
  if (home) return path.join(home, ".cursor-api-proxy", "config.json");
  return path.join(cwd, "cursor-api-proxy.config.json");
}

export type ParsedConfigFile = {
  path: string;
  exists: boolean;
  values: ConfigFileValues;
  /** Unknown keys and other non-fatal problems. */
  warnings: string[];
};

/**
 * Validates one value against its spec, returning the normalized value.
 * Throws `ConfigFileError` naming the key — mirroring how `env.ts` fails on a
 * bad `CURSOR_BRIDGE_MODE` rather than silently falling back.
 */
export function validateConfigValue(
  spec: ConfigFileKeySpec,
  raw: unknown,
): string | number | boolean | string[] | Record<string, string> {
  switch (spec.type) {
    case "boolean":
      if (typeof raw !== "boolean") {
        throw new ConfigFileError(
          `config file key "${spec.key}" must be a boolean (got ${describe(raw)})`,
          spec.key,
        );
      }
      return raw;
    case "number":
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new ConfigFileError(
          `config file key "${spec.key}" must be a finite number (got ${describe(raw)})`,
          spec.key,
        );
      }
      return raw;
    case "string":
      if (typeof raw !== "string") {
        throw new ConfigFileError(
          `config file key "${spec.key}" must be a string (got ${describe(raw)})`,
          spec.key,
        );
      }
      return raw;
    case "string[]":
      if (
        !Array.isArray(raw) ||
        raw.some((item) => typeof item !== "string")
      ) {
        throw new ConfigFileError(
          `config file key "${spec.key}" must be an array of strings (got ${describe(raw)})`,
          spec.key,
        );
      }
      return raw as string[];
    case "enum":
      if (typeof raw !== "string" || !spec.values?.includes(raw)) {
        throw new ConfigFileError(
          `config file key "${spec.key}" must be one of ${spec.values?.join(", ")} (got ${describe(raw)})`,
          spec.key,
        );
      }
      return raw;
    case "object": {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ConfigFileError(
          `config file key "${spec.key}" must be a JSON object (got ${describe(raw)})`,
          spec.key,
        );
      }
      const out: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value !== "string") {
          throw new ConfigFileError(
            `config file key "${spec.key}.${key}" must be a string (got ${describe(value)})`,
            spec.key,
          );
        }
        const k = key.trim();
        if (!k) {
          throw new ConfigFileError(
            `config file key "${spec.key}" contains an empty key`,
            spec.key,
          );
        }
        out[k] = value.trim();
      }
      return out;
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Validates a whole object. Unknown keys warn; refused keys and bad values
 * throw.
 */
export function validateConfigFileValues(raw: unknown): {
  values: ConfigFileValues;
  warnings: string[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigFileError("config file must contain a JSON object");
  }

  const values: ConfigFileValues = {};
  const warnings: string[] = [];

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (REFUSED_CONFIG_KEYS.includes(key)) {
      throw new ConfigFileError(
        `config file key "${key}" is not allowed — keys and tokens must come from the environment`,
        key,
      );
    }
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) {
      warnings.push(`config file: ignoring unknown key "${key}"`);
      continue;
    }
    if (value === null || value === undefined) continue;
    values[key] = validateConfigValue(spec, value);
  }

  return { values, warnings };
}

export function readConfigFile(filePath: string): ParsedConfigFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { path: filePath, exists: false, values: {}, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigFileError(`config file ${filePath} is not valid JSON: ${detail}`);
  }

  const { values, warnings } = validateConfigFileValues(parsed);
  return { path: filePath, exists: true, values, warnings };
}

/** Serializes a value the way the matching environment variable expects it. */
export function configValueToEnv(
  spec: ConfigFileKeySpec,
  value: string | number | boolean | string[] | Record<string, string>,
): string {
  if (spec.type === "boolean") return value ? "true" : "false";
  if (spec.type === "string[]") return (value as string[]).join(",");
  if (spec.type === "object") return JSON.stringify(value);
  return String(value);
}

/** The env-shaped overlay `loadEnvConfig` falls back to. */
export function configFileEnvOverlay(values: ConfigFileValues): Record<string, string> {
  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    const spec = SPEC_BY_KEY.get(key);
    if (!spec) continue;
    overlay[spec.env] = configValueToEnv(spec, value);
  }
  return overlay;
}

/**
 * Where each documented key's effective value came from. Only keys the file
 * knows about are reported; everything else is resolved by `env.ts` alone.
 */
export function computeConfigSources(
  env: Record<string, string | undefined>,
  fileValues: ConfigFileValues,
  cliKeys: ReadonlyArray<string> = [],
): Record<string, ConfigValueSource> {
  const sources: Record<string, ConfigValueSource> = {};
  for (const spec of CONFIG_FILE_KEYS) {
    if (cliKeys.includes(spec.key)) sources[spec.key] = "cli";
    else if (env[spec.env] != null && String(env[spec.env]).trim() !== "") {
      sources[spec.key] = "env";
    } else if (fileValues[spec.key] !== undefined) sources[spec.key] = "file";
    else sources[spec.key] = "default";
  }
  return sources;
}

/** Snapshot of the file layer, carried on `BridgeConfig` for the dashboard. */
export type ConfigFileState = {
  path: string;
  exists: boolean;
  values: ConfigFileValues;
  warnings: string[];
  sources: Record<string, ConfigValueSource>;
};

export const EMPTY_CONFIG_FILE_STATE: ConfigFileState = {
  path: "",
  exists: false,
  values: {},
  warnings: [],
  sources: {},
};

export type ConfigFileWriteResult = {
  path: string;
  /** The normalized object that was persisted. */
  values: ConfigFileValues;
  written: string[];
  /** Keys whose effective value will change once the proxy restarts. */
  restartRequired: string[];
  /** Keys written but shadowed by a CLI flag or environment variable. */
  noEffect: string[];
  warnings: string[];
};

export type ConfigFileWriteContext = {
  /** Effective values currently in force, used to detect real changes. */
  effective?: Record<string, unknown>;
  /** Per-key source, used to flag writes that a flag or env var shadows. */
  sources?: Record<string, ConfigValueSource>;
};

/**
 * Validates then persists the file. The write goes to a sibling temp file and
 * is renamed into place, so a crash mid-write cannot leave the proxy with a
 * half-written config it will refuse to start from.
 */
export function writeConfigFile(
  filePath: string,
  raw: unknown,
  current: ConfigFileValues = {},
  context: ConfigFileWriteContext = {},
): ConfigFileWriteResult {
  const { values, warnings } = validateConfigFileValues(raw);

  for (const key of Object.keys(values)) {
    const spec = SPEC_BY_KEY.get(key)!;
    if (!spec.editable) {
      throw new ConfigFileError(
        `config file key "${key}" is read-only from the dashboard — edit ${spec.env} or the file directly`,
        key,
      );
    }
  }

  const written = Object.keys(values);
  const changed = written.filter((key) => !sameValue(values[key], current[key]));
  // A key the environment or a flag already decides keeps its current value
  // after a restart, so promising one would be a lie.
  const shadowed = (key: string): boolean => {
    const source = context.sources?.[key];
    return source === "env" || source === "cli";
  };
  const noEffect = changed.filter(shadowed);
  const restartRequired = changed.filter(
    (key) =>
      !shadowed(key) &&
      (context.effective === undefined ||
        !sameValue(values[key], context.effective[key])),
  );

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(values, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best effort */
    }
    throw err;
  }

  return { path: filePath, values, written, restartRequired, noEffect, warnings };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
  }
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const aEntries = Object.entries(a as Record<string, unknown>).sort(
      ([x], [y]) => x.localeCompare(y),
    );
    const bEntries = Object.entries(b as Record<string, unknown>).sort(
      ([x], [y]) => x.localeCompare(y),
    );
    return (
      aEntries.length === bEntries.length &&
      aEntries.every(
        ([key, value], i) =>
          key === bEntries[i]![0] && value === bEntries[i]![1],
      )
    );
  }
  return a === b;
}
