/**
 * Shared append-with-rotation for the JSONL side logs (`requests.jsonl`,
 * `audit.jsonl`). Both streams have the same operational shape — append one
 * object per line, rename to `<path>.1` once the file would outgrow its cap —
 * so they share one implementation instead of drifting apart.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** Rename to `<path>.1` once the file would exceed `maxBytes` (0 disables). */
export function rotateJsonlIfNeeded(
  logPath: string,
  maxBytes: number,
  incomingBytes: number,
): void {
  if (maxBytes <= 0) return;
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return;
  }
  if (size + incomingBytes <= maxBytes) return;
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch (err) {
    console.error(`Failed to rotate ${path.basename(logPath)}:`, err);
  }
}

/** Serializes `record`, rotates when needed, and appends a single line. */
export function appendJsonlRecord(
  record: unknown,
  options: { logPath: string; maxBytes: number },
  label: string,
): void {
  const line = `${JSON.stringify(record)}\n`;
  try {
    const dir = path.dirname(options.logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateJsonlIfNeeded(
      options.logPath,
      options.maxBytes,
      Buffer.byteLength(line),
    );
    fs.appendFileSync(options.logPath, line);
  } catch (err) {
    console.error(`Failed to write ${label}:`, err);
  }
}
