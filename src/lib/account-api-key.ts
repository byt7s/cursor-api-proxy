import * as fs from "node:fs";
import * as path from "node:path";

import { TOKEN_FILE, writeCachedToken } from "./token-cache.js";

/** Per-account Cursor API key file (mode 0600). */
export const API_KEY_FILE = ".cursor-api-key";

export type ApiKeyAccountFiles = {
  configDir: string;
  name: string;
  authMethod: "api-key";
};

/**
 * Read a stored per-account Cursor API key, if present.
 */
export function readAccountApiKey(configDir?: string): string | undefined {
  if (!configDir) return undefined;
  try {
    const p = path.join(configDir, API_KEY_FILE);
    if (!fs.existsSync(p)) return undefined;
    return fs.readFileSync(p, "utf-8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Env vars to inject when spawning the Cursor agent for an API-key account.
 *
 * `AGENT_CLI_CREDENTIAL_STORE=file` is required on macOS: even with `--api-key`,
 * the CLI may still touch the login Keychain (prompt / exit 154/45) unless the
 * credential store is forced off Keychain.
 */
export function getAccountApiKeyEnv(
  configDir?: string,
): Record<string, string> | undefined {
  const key = readAccountApiKey(configDir);
  if (!key) return undefined;
  return {
    CURSOR_API_KEY: key,
    CURSOR_AUTH_TOKEN: key,
    AGENT_CLI_CREDENTIAL_STORE: "file",
  };
}

/**
 * Prepend `--api-key` when the account stores one.
 *
 * Needed because `CURSOR_CONFIG_DIR` pointing at a stub account profile makes the
 * CLI prefer macOS Keychain over `CURSOR_API_KEY` env alone.
 */
export function withAccountApiKeyArgs(
  args: string[],
  configDir?: string,
): string[] {
  const key = readAccountApiKey(configDir);
  if (!key) return args;
  if (args.includes("--api-key") || args.includes("--auth-token")) return args;
  return ["--api-key", key, ...args];
}

export function isApiKeyAccount(configDir: string): boolean {
  if (fs.existsSync(path.join(configDir, API_KEY_FILE))) return true;
  try {
    const configFile = path.join(configDir, "cli-config.json");
    if (!fs.existsSync(configFile)) return false;
    const raw = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authMethod?: string;
      authInfo?: { authId?: string };
    };
    if (raw.authMethod === "api-key") return true;
    return Boolean(raw.authInfo?.authId?.startsWith("api-key:"));
  } catch {
    return false;
  }
}

/**
 * Persist an API-key-backed account under the given config directory.
 * Creates `.cursor-api-key`, `.cursor-token`, and a minimal `cli-config.json`.
 */
export function writeApiKeyAccount(
  configDir: string,
  name: string,
  apiKey: string,
): ApiKeyAccountFiles {
  const key = apiKey.trim();
  if (!key) {
    throw new Error("API key must not be empty");
  }

  fs.mkdirSync(configDir, { recursive: true });

  fs.writeFileSync(path.join(configDir, API_KEY_FILE), key, {
    encoding: "utf-8",
    mode: 0o600,
  });
  writeCachedToken(configDir, key);

  const cliConfig = {
    authMethod: "api-key" as const,
    authInfo: {
      email: `api-key@${name}`,
      displayName: `API key (${name})`,
      authId: `api-key:${name}`,
    },
  };
  fs.writeFileSync(
    path.join(configDir, "cli-config.json"),
    `${JSON.stringify(cliConfig, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o600 },
  );

  return { configDir, name, authMethod: "api-key" };
}

/** True when the account dir has either browser auth or a stored API key. */
export function hasAccountCredentials(configDir: string): boolean {
  if (readAccountApiKey(configDir)) return true;
  const configFile = path.join(configDir, "cli-config.json");
  if (!fs.existsSync(configFile)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authInfo?: { email?: string };
    };
    return Boolean(config?.authInfo?.email);
  } catch {
    return false;
  }
}

export { TOKEN_FILE };
