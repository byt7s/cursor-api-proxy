import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import type { BridgeConfig } from "./config.js";
import { TOKEN_FILE } from "./token-cache.js";

export const API_KEY_FILE = ".cursor-api-key";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

function hasSessionAuth(dir: string): boolean {
  const configFile = path.join(dir, "cli-config.json");
  if (!fs.existsSync(configFile)) return false;
  try {
    const config = JSON.parse(fs.readFileSync(configFile, "utf-8")) as {
      authInfo?: { email?: string; authId?: string };
    };
    if (config?.authInfo?.email) return true;
    if (config?.authInfo?.authId?.startsWith("api-key:")) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function hasApiKeyFile(dir: string): boolean {
  try {
    const p = path.join(dir, API_KEY_FILE);
    if (!fs.existsSync(p)) return false;
    return Boolean(fs.readFileSync(p, "utf-8").trim());
  } catch {
    return false;
  }
}

function hasCachedToken(dir: string): boolean {
  try {
    const p = path.join(dir, TOKEN_FILE);
    if (!fs.existsSync(p)) return false;
    return Boolean(fs.readFileSync(p, "utf-8").trim());
  } catch {
    return false;
  }
}

function accountCredentialDetail(dir: string): { ok: boolean; detail: string } {
  const parts: string[] = [];
  if (hasApiKeyFile(dir)) parts.push(API_KEY_FILE);
  if (hasSessionAuth(dir)) parts.push("cli-config session");
  if (hasCachedToken(dir)) parts.push(TOKEN_FILE);
  if (parts.length > 0) {
    return { ok: true, detail: `${dir} (${parts.join(", ")})` };
  }
  return {
    ok: false,
    detail: `no session/API key in ${dir} (need ${API_KEY_FILE}, cli-config auth, or ${TOKEN_FILE})`,
  };
}

function envHasApiKey(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(
    env.CURSOR_API_KEY?.trim() || env.CURSOR_AUTH_TOKEN?.trim(),
  );
}

/** Cheap PATH lookup; does not spawn the agent. */
export function isCommandResolvable(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep)) {
    return fs.existsSync(trimmed);
  }
  try {
    if (process.platform === "win32") {
      execFileSync("where", [trimmed], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
    } else {
      execFileSync("which", [trimmed], {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2000,
      });
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Lightweight preflight checks for account / model readiness.
 * Does not start the HTTP server or call the Cursor API.
 */
export function runDoctor(
  config: BridgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): DoctorResult {
  const checks: DoctorCheck[] = [];

  const modelOk = Boolean(config.defaultModel?.trim());
  checks.push({
    name: "defaultModel",
    ok: modelOk,
    detail: modelOk
      ? `defaultModel=${config.defaultModel}`
      : "defaultModel is empty",
  });

  if (config.configDirs.length === 0) {
    const keyOk = envHasApiKey(env);
    checks.push({
      name: "accountDirs",
      ok: keyOk,
      detail: keyOk
        ? "no configDirs (single account via CURSOR_API_KEY / CURSOR_AUTH_TOKEN)"
        : "no configDirs and no CURSOR_API_KEY/CURSOR_AUTH_TOKEN in the environment",
    });
  } else {
    for (const dir of config.configDirs) {
      const exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
      const name = path.basename(dir);
      if (!exists) {
        checks.push({
          name: `accountDir:${name}`,
          ok: false,
          detail: `missing: ${dir}`,
        });
        continue;
      }
      const cred = accountCredentialDetail(dir);
      checks.push({
        name: `accountDir:${name}`,
        ok: cred.ok,
        detail: cred.detail,
      });
    }
  }

  const agentTarget = config.acpCommand || config.agentBin;
  const agentOk = isCommandResolvable(agentTarget);
  checks.push({
    name: "agentCommand",
    ok: agentOk,
    detail: agentOk
      ? `resolvable: ${agentTarget}`
      : `not found on PATH / filesystem: ${agentTarget}`,
  });

  return {
    ok: checks.every((c) => c.ok),
    checks,
  };
}
