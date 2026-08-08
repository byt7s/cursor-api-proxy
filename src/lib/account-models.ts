/**
 * Per-account model allowlist.
 *
 * File: `~/.cursor-api-proxy/accounts/<name>/.cursor-bridge-models`
 * Format: one model id per line; `#` starts a comment; blank lines ignored.
 * Missing or empty file = allow all models.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const MODELS_FILE = ".cursor-bridge-models";

/** `undefined` means unrestricted (missing/empty file). */
export function readAccountAllowedModels(
  configDir: string | undefined,
): string[] | undefined {
  if (!configDir) return undefined;
  const filePath = path.join(configDir, MODELS_FILE);
  let raw: string;
  try {
    if (!fs.existsSync(filePath)) return undefined;
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return undefined;
  }

  const models: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Strip inline comments: `composer-2  # notes`
    const id = trimmed.split(/\s+#/)[0]!.trim();
    if (id) models.push(id);
  }
  return models.length === 0 ? undefined : models;
}

/** True when the account may run `model` (missing allowlist = allow all). */
export function accountAllowsModel(
  configDir: string | undefined,
  model: string | undefined,
): boolean {
  if (!model || !model.trim()) return true;
  const allowed = readAccountAllowedModels(configDir);
  if (allowed === undefined) return true;
  const key = model.trim().toLowerCase();
  return allowed.some((id) => id.toLowerCase() === key);
}

/**
 * Persist the allowlist. Pass an empty array (or omit all models) to remove
 * the file so the account becomes unrestricted again.
 */
export function writeAccountAllowedModels(
  configDir: string,
  models: string[],
): void {
  fs.mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, MODELS_FILE);
  const cleaned = models
    .map((m) => m.trim())
    .filter(Boolean);
  if (cleaned.length === 0) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* best effort */
    }
    return;
  }
  const body =
    "# One Cursor model id per line. Empty/missing file = allow all.\n" +
    cleaned.join("\n") +
    "\n";
  fs.writeFileSync(filePath, body, { encoding: "utf-8", mode: 0o600 });
}
