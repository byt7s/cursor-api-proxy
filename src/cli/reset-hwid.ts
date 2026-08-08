/**
 * cursor-api-proxy reset-hwid
 *
 * Resets Cursor's telemetry / machine IDs so the app appears as a fresh
 * installation.  Mirrors the logic from the open-source cursor-reset tool:
 *   • telemetry.machineId       — SHA-256 of 32 random bytes
 *   • telemetry.macMachineId    — SHA-512 of 64 random bytes
 *   • telemetry.devDeviceId     — random UUID v4
 *   • telemetry.sqmId           — {UUID_UPPER}
 *   • storage.serviceMachineId  — random UUID v4
 *
 * Files touched (macOS):
 *   ~/Library/Application Support/Cursor/User/globalStorage/storage.json
 *   ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
 *   ~/Library/Application Support/Cursor/machineId
 *
 * Optionally wipes Cookies / Session Storage / Local Storage so Cursor
 * cannot fingerprint the session.
 */

import * as crypto from "node:crypto";
import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return crypto.randomUUID();
}

function sha256(): string {
  return crypto.createHash("sha256").update(crypto.randomBytes(32)).digest("hex");
}

function sha512(): string {
  return crypto.createHash("sha512").update(crypto.randomBytes(64)).digest("hex");
}

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

function getCursorGlobalStorage(): string {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Cursor",
      "User",
      "globalStorage",
    );
  }
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA ?? "";
    return path.join(appdata, "Cursor", "User", "globalStorage");
  }
  // Linux
  const xdg = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(xdg, "Cursor", "User", "globalStorage");
}

function getCursorRoot(): string {
  return path.dirname(path.dirname(getCursorGlobalStorage()));
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

export function generateNewIds(): Record<string, string> {
  return {
    "telemetry.machineId": sha256(),
    "telemetry.macMachineId": sha512(),
    "telemetry.devDeviceId": uuid(),
    "telemetry.sqmId": `{${uuid().toUpperCase()}}`,
    "storage.serviceMachineId": uuid(),
  };
}

// ---------------------------------------------------------------------------
// Kill Cursor
// ---------------------------------------------------------------------------

function killCursor(): void {
  log("🔪", "Stopping Cursor processes...");
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/IM", "Cursor.exe"], { stdio: "pipe" });
    } else {
      spawnSync("pkill", ["-x", "Cursor"], { stdio: "pipe" });
      spawnSync("pkill", ["-f", "Cursor.app"], { stdio: "pipe" });
    }
  } catch {
    /* cursor might not be running */
  }
  log("✅", "Cursor stopped (or was not running)");
}

// ---------------------------------------------------------------------------
// storage.json
// ---------------------------------------------------------------------------

function updateStorageJson(
  storagePath: string,
  ids: Record<string, string>,
): void {
  if (!fs.existsSync(storagePath)) {
    log("⚠️ ", `storage.json not found: ${storagePath}`);
    return;
  }

  try {
    // Remove immutable flag on macOS
    if (process.platform === "darwin") {
      try {
        execSync(`chflags nouchg "${storagePath}"`, { stdio: "pipe" });
        execSync(`chmod 644 "${storagePath}"`, { stdio: "pipe" });
      } catch { /* ignore */ }
    }

    const raw = fs.readFileSync(storagePath, "utf-8");
    const data = JSON.parse(raw) as Record<string, unknown>;
    Object.assign(data, ids);
    fs.writeFileSync(storagePath, JSON.stringify(data, null, 2), "utf-8");
    log("✅", "storage.json updated");
  } catch (e) {
    log("❌", `storage.json error: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// state.vscdb (SQLite)
// ---------------------------------------------------------------------------

function updateStateVscdb(
  dbPath: string,
  ids: Record<string, string>,
): void {
  if (!fs.existsSync(dbPath)) {
    log("⚠️ ", `state.vscdb not found: ${dbPath}`);
    return;
  }

  const sqlite3 = findSqlite3();
  if (!sqlite3) {
    log("⚠️ ", "sqlite3 not found — skipping state.vscdb (install sqlite3 to fix)");
    return;
  }

  try {
    if (process.platform === "darwin") {
      try {
        execSync(`chflags nouchg "${dbPath}"`, { stdio: "pipe" });
        execSync(`chmod 644 "${dbPath}"`, { stdio: "pipe" });
      } catch { /* ignore */ }
    }

    const keyRe = /^[A-Za-z0-9._-]+$/;
    /** Hex / UUID / telemetry.sqmId brace form only — rejects quotes and SQL metacharacters */
    const valueRe = /^[A-Fa-f0-9\-{}]+$/i;
    for (const [k, v] of Object.entries(ids)) {
      if (!keyRe.test(k) || !valueRe.test(v)) {
        log("⚠️ ", "state.vscdb: skipping update — unexpected key/value format");
        return;
      }
    }

    // Build SQL (values validated as hex/UUID-shaped only)
    const stmts = Object.entries(ids)
      .map(([k, v]) =>
        `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('${k}', '${v}');`,
      )
      .join("\n");

    const result = spawnSync(
      sqlite3,
      [dbPath],
      {
        input: `CREATE TABLE IF NOT EXISTS ItemTable (key TEXT PRIMARY KEY, value TEXT NOT NULL);\n${stmts}`,
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );

    if (result.status !== 0) {
      log("⚠️ ", `state.vscdb error: ${result.stderr?.trim()}`);
    } else {
      log("✅", "state.vscdb updated");
    }
  } catch (e) {
    log("❌", `state.vscdb error: ${e}`);
  }
}

function findSqlite3(): string | null {
  for (const candidate of ["/usr/bin/sqlite3", "/usr/local/bin/sqlite3", "sqlite3"]) {
    try {
      const r = spawnSync(candidate, ["--version"], { stdio: "pipe" });
      if (r.status === 0) return candidate;
    } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// machineId file
// ---------------------------------------------------------------------------

function updateMachineIdFile(
  machineId: string,
  cursorRoot: string,
): void {
  const candidates =
    process.platform === "linux"
      ? [
          path.join(cursorRoot, "machineid"),
          path.join(cursorRoot, "machineId"),
        ]
      : [path.join(cursorRoot, "machineId")];

  const filePath = candidates.find(fs.existsSync) ?? candidates[0];

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath) && process.platform === "darwin") {
      try {
        execSync(`chflags nouchg "${filePath}"`, { stdio: "pipe" });
        execSync(`chmod 644 "${filePath}"`, { stdio: "pipe" });
      } catch { /* ignore */ }
    }
    fs.writeFileSync(filePath, machineId + "\n", "utf-8");
    log("✅", `machineId file updated (${path.basename(filePath)})`);
  } catch (e) {
    log("⚠️ ", `machineId file error: ${e}`);
  }
}

// ---------------------------------------------------------------------------
// Optional: wipe session / cookie data
// ---------------------------------------------------------------------------

const DIRS_TO_WIPE = [
  "Session Storage",
  "Local Storage",
  "IndexedDB",
  "Cache",
  "Code Cache",
  "GPUCache",
  "Service Worker",
  "Network",
  "Cookies",
  "Cookies-journal",
];

function deepClean(cursorRoot: string): void {
  log("🧹", "Deep-cleaning session data...");
  let wiped = 0;

  for (const name of DIRS_TO_WIPE) {
    const target = path.join(cursorRoot, name);
    if (!fs.existsSync(target)) continue;
    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        fs.rmSync(target, { recursive: true, force: true });
      } else {
        fs.unlinkSync(target);
      }
      wiped++;
    } catch { /* ignore */ }
  }

  log("✅", `Wiped ${wiped} cache/session items`);
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export type ResetHwidResult = {
  ok: true;
  dryRun: boolean;
  deepClean: boolean;
  ids?: Record<string, string>;
  paths?: { storageJson: string; stateVscdb: string; machineId: string };
};

/**
 * Core HWID reset used by CLI and dashboard. Throws instead of process.exit.
 */
export async function runResetHwid(opts: {
  deepClean?: boolean;
  dryRun?: boolean;
} = {}): Promise<ResetHwidResult> {
  const globalStorage = getCursorGlobalStorage();
  const cursorRoot = getCursorRoot();
  const paths = {
    storageJson: path.join(globalStorage, "storage.json"),
    stateVscdb: path.join(globalStorage, "state.vscdb"),
    machineId: path.join(cursorRoot, "machineId"),
  };

  if (!fs.existsSync(globalStorage)) {
    throw new Error(
      `Cursor config not found at ${globalStorage}. Make sure Cursor is installed and has been run at least once.`,
    );
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      deepClean: Boolean(opts.deepClean),
      paths,
    };
  }

  killCursor();
  await new Promise((r) => setTimeout(r, 800));

  const newIds = generateNewIds();
  updateStorageJson(paths.storageJson, newIds);
  updateStateVscdb(paths.stateVscdb, newIds);
  updateMachineIdFile(newIds["telemetry.machineId"], cursorRoot);

  if (opts.deepClean) {
    deepClean(cursorRoot);
  }

  return {
    ok: true,
    dryRun: false,
    deepClean: Boolean(opts.deepClean),
    ids: newIds,
    paths,
  };
}

export async function handleResetHwid(opts: {
  deepClean?: boolean;
  dryRun?: boolean;
} = {}): Promise<void> {
  console.log("\n🔄 Cursor HWID Reset\n");
  console.log("  Resets all machine / telemetry IDs so Cursor sees a fresh install.");
  console.log("  Cursor must be closed — it will be killed automatically.\n");

  try {
    const result = await runResetHwid(opts);
    if (result.dryRun && result.paths) {
      console.log("  [DRY RUN] Would reset IDs in:");
      console.log(`    ${result.paths.storageJson}`);
      console.log(`    ${result.paths.stateVscdb}`);
      console.log(`    ${result.paths.machineId}`);
      return;
    }
    if (result.ids) {
      log("🎲", "Generated new IDs:");
      for (const [k, v] of Object.entries(result.ids)) {
        console.log(`       ${k}: ${v}`);
      }
      console.log();
      log("📝", "Updated storage.json / state.vscdb / machineId");
      if (result.deepClean) {
        console.log();
        log("✅", "Deep clean requested (session/cookie wipe)");
      }
    }
    console.log("\n✅ HWID reset complete. You can now restart Cursor.\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${msg}`);
    process.exit(1);
  }
}
