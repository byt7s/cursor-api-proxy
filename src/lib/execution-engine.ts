import * as fs from "node:fs";
import * as path from "node:path";

/** Per-account override file next to `.cursor-api-key` / `cli-config.json`. */
export const ENGINE_FILE = ".cursor-bridge-engine";

export type ExecutionEngine = "acp" | "sdk";

export function parseExecutionEngine(
  raw: string | undefined,
): ExecutionEngine | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "acp" || v === "sdk") return v;
  return undefined;
}

/**
 * Resolve the execution engine for an account.
 *
 * Precedence: per-account `.cursor-bridge-engine` → `defaultEngine`
 * (from `CURSOR_BRIDGE_DEFAULT_ENGINE`, default `acp`).
 */
export function resolveAccountEngine(
  configDir: string | undefined,
  defaultEngine: ExecutionEngine = "acp",
): ExecutionEngine {
  if (!configDir) return defaultEngine;
  try {
    const p = path.join(configDir, ENGINE_FILE);
    if (!fs.existsSync(p)) return defaultEngine;
    const parsed = parseExecutionEngine(fs.readFileSync(p, "utf-8"));
    return parsed ?? defaultEngine;
  } catch {
    return defaultEngine;
  }
}

/** Write per-account engine override (`sdk` | `acp`). */
export function writeAccountEngine(
  configDir: string,
  engine: ExecutionEngine,
): void {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, ENGINE_FILE), `${engine}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}
