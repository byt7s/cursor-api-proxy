import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { buildAccountsReport } from "../cli/accounts.js";
import { ACCOUNTS_DIR } from "../cli/constants.js";
import { saveApiKeyAccount } from "../cli/login.js";
import { runResetHwid } from "../cli/reset-hwid.js";
import { writeAccountApiKey } from "./account-api-key.js";
import { describeApiKeys } from "./api-keys.js";
import {
  appendAuditRecord,
  auditRouteFor,
  buildAuditRecord,
  recentAuditRecords,
} from "./audit-log.js";
import type { BridgeConfig } from "./config.js";
import {
  authorizeSensitiveApi,
  dashboardIsKeyProtected,
  type AuthorizeResult,
} from "./dashboard-auth.js";
import { runDoctor } from "./doctor.js";
import { BodyTooLargeError } from "./http.js";
import { recentRequestRecords } from "./request-record.js";
import {
  computeSessionStats,
  readLastLines,
  recentSessionRequests,
} from "./session-log.js";

const PLIST_LABEL = "com.cursor-api-proxy";

/**
 * Target of the current mutation when it only becomes known after the body is
 * parsed (account name, control action). Path-derived targets are resolved by
 * `auditRouteFor` instead.
 */
const auditTargets = new WeakMap<http.ServerResponse, string>();

function setAuditTarget(res: http.ServerResponse, target: string): void {
  if (target) auditTargets.set(res, target);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

const START_TIME = Date.now();

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": buf.length,
    "cache-control": "no-store",
  });
  res.end(buf);
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found\n");
}

function safeJoin(root: string, rel: string): string | null {
  const target = path.normalize(path.join(root, rel));
  if (!target.startsWith(root)) return null;
  return target;
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return notFound(res);
    const ext = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": mime,
      "content-length": stat.size,
      "cache-control": "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function launchdLoadedSync(): boolean {
  try {
    const out = execSync("launchctl list 2>/dev/null", { encoding: "utf8" });
    return out.split("\n").some((l) => l.trim().endsWith(PLIST_LABEL));
  } catch {
    return false;
  }
}

function storagePaths(config: BridgeConfig) {
  const storageDir = path.dirname(config.sessionsLogPath);
  const pidFile = path.join(storageDir, "proxy.pid");
  const serviceLog = path.join(storageDir, "proxy.log");
  return { storageDir, pidFile, serviceLog };
}

function getStatus(
  config: BridgeConfig,
  version: string,
  cb: (s: Record<string, unknown>) => void,
): void {
  const root = packageRoot();
  const publicDir = path.join(root, "public");
  const docsDir = path.join(root, "docs");
  const { storageDir, pidFile, serviceLog } = storagePaths(config);

  let pid: number | null = null;
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) pid = n;
  } catch {
    /* no pid file */
  }

  let running = pid === process.pid;
  if (!running && pid) {
    try {
      process.kill(pid, 0);
      running = true;
    } catch {
      running = false;
    }
  }

  const ownPidIsCurrent = pid === process.pid;
  if (!ownPidIsCurrent) {
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid));
      pid = process.pid;
      running = true;
    } catch {
      /* ignore */
    }
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const plistPath = path.join(home, "Library/LaunchAgents", `${PLIST_LABEL}.plist`);
  const launchdLoaded = process.platform === "darwin" ? launchdLoadedSync() : false;

  const env = process.env;
  cb({
    running,
    pid,
    port: config.port,
    host: config.host,
    version,
    uptimeSeconds: Math.floor((Date.now() - START_TIME) / 1000),
    launchdLoaded,
    plistPath,
    packageRoot: root,
    publicDir,
    docsDir,
    storageDir,
    sessionsLogPath: config.sessionsLogPath,
    serviceLog,
    pidFile,
    apiKeyConfigured: Boolean(env.CURSOR_API_KEY ?? env.CURSOR_AUTH_TOKEN),
    bridgeApiKeyRequired: Boolean(config.requiredKey),
    dashboardKeyRequired: Boolean(config.dashboardKey),
    dashboardKeyProtected: dashboardIsKeyProtected(config),
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    startedAt: new Date(START_TIME).toISOString(),
  });
}

function sanitizedBridgeConfig(
  config: BridgeConfig,
  caller?: AuthorizeResult,
): Record<string, unknown> {
  return {
    // Labels, scopes and 6-char fingerprints only — never key material.
    apiKeys: describeApiKeys(config.apiKeys),
    dashboardKeyConfigured: Boolean(config.dashboardKey),
    keyRateLimitPerMin: config.keyRateLimitPerMin,
    auditLogPath: config.auditLogPath,
    auditLogEnabled: config.auditLogEnabled,
    maxBodyBytes: config.maxBodyBytes,
    corsOrigins: config.corsOrigins,
    /** Identifies which credential the caller of this request used. */
    caller: caller
      ? { actor: caller.actor, fingerprint: caller.fingerprint }
      : { actor: "unknown" },
    agentBin: config.agentBin,
    useAcp: config.useAcp,
    host: config.host,
    port: config.port,
    defaultModel: config.defaultModel,
    mode: config.mode,
    force: config.force,
    approveMcps: config.approveMcps,
    strictModel: config.strictModel,
    workspace: config.workspace,
    timeoutMs: config.timeoutMs,
    sessionsLogPath: config.sessionsLogPath,
    requestsLogPath: config.requestsLogPath,
    requestsLogEnabled: config.requestsLogEnabled,
    requestsLogMaxBytes: config.requestsLogMaxBytes,
    metricsEnabled: config.metricsEnabled,
    chatOnlyWorkspace: config.chatOnlyWorkspace,
    verbose: config.verbose,
    maxMode: config.maxMode,
    requiredKey: Boolean(config.requiredKey),
    tlsEnabled: Boolean(config.tlsCertPath && config.tlsKeyPath),
    configDirsCount: config.configDirs.length,
    multiPort: config.multiPort,
    contextPreamble: config.contextPreamble,
    bridgePackageVersion: config.bridgePackageVersion,
    maxConcurrentRuns: config.maxConcurrentRuns,
    maxConcurrentRunsPerAccount: config.maxConcurrentRunsPerAccount,
    sdkMaxConcurrentRuns: config.sdkMaxConcurrentRuns,
    sdkMaxConcurrentRunsPerAccount: config.sdkMaxConcurrentRunsPerAccount,
    admissionWaitMs: config.admissionWaitMs,
    contextExtraConfigured: Boolean(config.contextExtra),
  };
}

function runControl(
  action: string,
  config: BridgeConfig,
  cb: (err: Error | null, result?: { ok: boolean; action: string; scheduled: boolean }) => void,
): void {
  const allowed = ["start", "stop", "restart", "enable", "disable"];
  if (!allowed.includes(action)) {
    return cb(new Error(`invalid action: ${action}`));
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const cliPath = path.join(home, ".local", "bin", "cursor-api-proxy");
  if (!fs.existsSync(cliPath)) {
    return cb(new Error(`CLI not found at ${cliPath} (see docs/WIKI.md)`));
  }
  const { serviceLog } = storagePaths(config);
  try {
    fs.mkdirSync(path.dirname(serviceLog), { recursive: true });
  } catch {
    /* ignore */
  }
  const cmd = `sleep 0.4 && '${cliPath.replace(/'/g, "'\\''")}' ${action} >> '${serviceLog.replace(/'/g, "'\\''")}' 2>&1`;
  const child = spawn("sh", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
    cwd: packageRoot(),
    env: process.env,
  });
  child.unref();
  cb(null, { ok: true, action, scheduled: true });
}

function parseQuery(url: string): Record<string, string> {
  const i = url.indexOf("?");
  const out: Record<string, string> = {};
  if (i < 0) return out;
  for (const kv of url.slice(i + 1).split("&")) {
    const [k, v = ""] = kv.split("=");
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v);
  }
  return out;
}

/**
 * Mutating dashboard APIs and sensitive GETs. Resolution order lives in
 * `dashboard-auth.ts`: admin-scoped key → dedicated dashboard key → legacy
 * `CURSOR_BRIDGE_API_KEY` → loopback fallback.
 */
export function authorizeDashboardApi(
  req: http.IncomingMessage,
  config: BridgeConfig,
  kind: "mutate" | "sensitiveRead",
): AuthorizeResult {
  return authorizeSensitiveApi(req, config, kind);
}

function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
  cb: (err: Error | null, body: Record<string, unknown>) => void,
): void {
  let raw = "";
  let bytes = 0;
  let done = false;
  req.on("data", (c: Buffer | string) => {
    if (done) return;
    bytes += Buffer.byteLength(c);
    if (maxBytes > 0 && bytes > maxBytes) {
      // Drain rather than destroy so the 413 actually reaches the client.
      done = true;
      raw = "";
      req.resume();
      cb(new BodyTooLargeError(maxBytes), {});
      return;
    }
    raw += c;
  });
  req.on("end", () => {
    if (done) return;
    done = true;
    try {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      cb(null, body && typeof body === "object" ? body : {});
    } catch {
      cb(new Error("invalid json"), {});
    }
  });
  req.on("error", (err) => {
    if (done) return;
    done = true;
    cb(err, {});
  });
}

function jsonBodyError(res: http.ServerResponse, err: Error): void {
  if (err instanceof BodyTooLargeError) {
    return json(res, 413, {
      error: err.message,
      code: "payload_too_large",
      maxBytes: err.maxBytes,
    });
  }
  return json(res, 400, { error: err.message });
}

function removeAccountDir(accountName: string): void {
  const name = accountName.trim();
  if (!name || name.includes("/") || name.includes("\\") || name === "." || name === "..") {
    throw new Error("invalid account name");
  }
  const configDir = path.join(ACCOUNTS_DIR, name);
  if (!fs.existsSync(configDir)) {
    throw new Error(`Account '${name}' not found`);
  }
  fs.rmSync(configDir, { recursive: true, force: true });
}

function setAccountKey(accountName: string, apiKey: string): void {
  const name = accountName.trim();
  const key = apiKey.trim();
  if (!name || !key) {
    throw new Error("name and apiKey are required");
  }
  if (!key.startsWith("crsr_")) {
    throw new Error("apiKey must look like a Dashboard API key (crsr_… prefix)");
  }
  const configDir = path.join(ACCOUNTS_DIR, name);
  if (!fs.existsSync(configDir)) {
    throw new Error(`Account '${name}' not found`);
  }
  writeAccountApiKey(configDir, key);
}

export type AdminDashboardOpts = {
  version: string;
  config: BridgeConfig;
};

export function adminDashboardMatches(req: http.IncomingMessage): boolean {
  const url = req.url ?? "";
  const pathname = url.split("?")[0] ?? "";
  if (req.method === "GET" && (pathname === "/" || pathname === "/wiki")) return true;
  if (req.method === "GET" && pathname.startsWith("/static/")) return true;
  if (req.method === "GET" && pathname.startsWith("/api/")) return true;
  if (
    (req.method === "POST" || req.method === "PUT" || req.method === "DELETE") &&
    pathname.startsWith("/api/")
  ) {
    return true;
  }
  return false;
}

export function handleAdminDashboard(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: AdminDashboardOpts,
): void {
  const { config, version } = opts;
  const root = packageRoot();
  const publicDir = path.join(root, "public");
  const wikiFile = path.join(root, "docs", "WIKI.md");
  const url = req.url ?? "/";
  const pathname = url.split("?")[0] ?? "/";
  const q = parseQuery(url);

  // `/` and `/wiki` serve the same React shell; the app picks the route from
  // the hash (or from `/wiki` on first load) and renders client-side.
  if (req.method === "GET" && (pathname === "/" || pathname === "/wiki")) {
    return serveFile(res, path.join(publicDir, "dashboard", "index.html"));
  }
  if (req.method === "GET" && pathname.startsWith("/static/")) {
    const rel = pathname.slice("/static/".length);
    const target = safeJoin(publicDir, rel);
    if (!target) return notFound(res);
    return serveFile(res, target);
  }

  if (req.method === "GET" && pathname === "/api/status") {
    return getStatus(config, version, (s) => json(res, 200, s));
  }

  const sensitiveGet =
    req.method === "GET" &&
    (pathname === "/api/config" ||
      pathname === "/api/accounts" ||
      pathname === "/api/doctor" ||
      pathname === "/api/audit" ||
      pathname === "/api/requests");

  const isMutating =
    req.method === "POST" || req.method === "PUT" || req.method === "DELETE";

  let auth: AuthorizeResult | undefined;
  if (sensitiveGet || (isMutating && pathname.startsWith("/api/"))) {
    auth = authorizeDashboardApi(
      req,
      config,
      isMutating ? "mutate" : "sensitiveRead",
    );
  }

  // Mutations are audited whatever the outcome — a refused attempt is exactly
  // what an operator wants to see after a key leak.
  if (isMutating && pathname.startsWith("/api/")) {
    const { route, target } = auditRouteFor(pathname);
    const actor = auth?.actor ?? "anonymous";
    const fingerprint = auth?.fingerprint;
    const denial = auth && !auth.ok ? auth.error : undefined;
    res.on("finish", () => {
      appendAuditRecord(
        buildAuditRecord({
          method: req.method ?? "?",
          route,
          actor,
          actorFingerprint: fingerprint,
          remoteAddress: req.socket?.remoteAddress ?? "unknown",
          target: target ?? auditTargets.get(res),
          status: res.statusCode,
          error: denial,
        }),
        {
          enabled: config.auditLogEnabled,
          logPath: config.auditLogPath,
          maxBytes: config.auditLogMaxBytes,
        },
      );
    });
  }

  if (auth && !auth.ok) return json(res, auth.status, { error: auth.error });

  if (req.method === "GET" && pathname === "/api/config") {
    return json(res, 200, sanitizedBridgeConfig(config, auth));
  }
  if (req.method === "GET" && pathname === "/api/audit") {
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 50));
    if (!config.auditLogEnabled) {
      return json(res, 200, {
        path: config.auditLogPath,
        enabled: false,
        records: [],
      });
    }
    return readLastLines(config.auditLogPath, 20_000, (err, lines) => {
      json(res, 200, {
        path: config.auditLogPath,
        enabled: true,
        records: err ? [] : recentAuditRecords(lines, limit),
      });
    });
  }
  if (req.method === "GET" && pathname === "/api/log") {
    const n = Math.min(5000, Math.max(1, Number(q.lines) || 100));
    return readLastLines(config.sessionsLogPath, n, (err, lines) => {
      if (err) return json(res, 500, { error: String(err) });
      json(res, 200, { path: config.sessionsLogPath, lines });
    });
  }
  if (req.method === "POST" && pathname === "/api/log/clear") {
    const logPath = config.sessionsLogPath;
    const dir = path.dirname(logPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }

    const archivedAt = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${logPath}.${archivedAt}.archive`;

    try {
      if (fs.existsSync(logPath)) {
        const st = fs.statSync(logPath);
        if (st.size > 0) fs.renameSync(logPath, archivePath);
        else fs.writeFileSync(archivePath, "", "utf8");
      } else {
        fs.writeFileSync(archivePath, "", "utf8");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: msg });
    }

    try {
      fs.writeFileSync(logPath, "", "utf8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json(res, 500, { error: msg });
    }

    return json(res, 200, { archivePath });
  }
  if (req.method === "GET" && pathname === "/api/stats") {
    const hours = Math.min(168, Math.max(1, Number(q.hours) || 24));
    return readLastLines(config.sessionsLogPath, 20_000, (err, lines) => {
      if (err) return json(res, 500, { error: String(err) });
      json(res, 200, computeSessionStats(lines, hours));
    });
  }
  if (req.method === "GET" && pathname === "/api/accounts") {
    void buildAccountsReport()
      .then((report) => json(res, 200, report))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        json(res, 500, { error: msg });
      });
    return;
  }
  if (req.method === "POST" && pathname === "/api/accounts") {
    return readJsonBody(req, config.maxBodyBytes, (err, body) => {
      if (err) return jsonBodyError(res, err);
      const name = String(body.name ?? "").trim();
      setAuditTarget(res, name);
      const apiKey = String(body.apiKey ?? "").trim();
      if (!name || !apiKey) {
        return json(res, 400, { error: "name and apiKey are required" });
      }
      try {
        const saved = saveApiKeyAccount(name, apiKey);
        // Never echo the raw key.
        return json(res, 201, {
          ok: true,
          name: saved.name,
          configDir: saved.configDir,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return json(res, 400, { error: msg });
      }
    });
  }
  if (req.method === "DELETE" && pathname.startsWith("/api/accounts/")) {
    const name = decodeURIComponent(pathname.slice("/api/accounts/".length));
    try {
      removeAccountDir(name);
      return json(res, 200, { ok: true, name });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = /not found/i.test(msg) ? 404 : 400;
      return json(res, status, { error: msg });
    }
  }
  if (req.method === "PUT" && pathname.startsWith("/api/accounts/") && pathname.endsWith("/key")) {
    const mid = pathname.slice("/api/accounts/".length, -"/key".length);
    const name = decodeURIComponent(mid.replace(/\/$/, ""));
    return readJsonBody(req, config.maxBodyBytes, (err, body) => {
      if (err) return jsonBodyError(res, err);
      const apiKey = String(body.apiKey ?? "").trim();
      try {
        setAccountKey(name, apiKey);
        return json(res, 200, { ok: true, name });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = /not found/i.test(msg) ? 404 : 400;
        return json(res, status, { error: msg });
      }
    });
  }
  if (req.method === "GET" && pathname === "/api/doctor") {
    try {
      const result = runDoctor(config, process.env);
      return json(res, 200, result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return json(res, 500, { error: msg });
    }
  }
  if (req.method === "POST" && pathname === "/api/reset-hwid") {
    return readJsonBody(req, config.maxBodyBytes, (err, body) => {
      if (err) return jsonBodyError(res, err);
      const deepClean = Boolean(body.deepClean);
      setAuditTarget(res, deepClean ? "deep-clean" : "standard");
      void runResetHwid({ deepClean })
        .then((result) =>
          json(res, 200, {
            ok: true,
            deepClean: result.deepClean,
            // Do not return raw machine ids to the browser by default.
          }),
        )
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          json(res, 500, { error: msg });
        });
    });
  }
  if (req.method === "GET" && pathname === "/api/requests") {
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 40));
    // Prefer the structured JSONL log (model, engine, account, latency spans)
    // and fall back to parsing the plain-text sessions log when it is disabled
    // or has not been written yet.
    const serveTextLog = () =>
      readLastLines(config.sessionsLogPath, 20_000, (err, lines) => {
        if (err) return json(res, 500, { error: String(err) });
        json(res, 200, {
          path: config.sessionsLogPath,
          source: "text",
          requests: recentSessionRequests(lines, limit),
        });
      });

    if (!config.requestsLogEnabled) return serveTextLog();

    return readLastLines(config.requestsLogPath, 20_000, (err, lines) => {
      const records = err ? [] : recentRequestRecords(lines, limit);
      if (records.length === 0) return serveTextLog();
      json(res, 200, {
        path: config.requestsLogPath,
        source: "jsonl",
        requests: records,
      });
    });
  }
  if (req.method === "GET" && pathname === "/api/wiki") {
    fs.readFile(wikiFile, "utf8", (err, data) => {
      if (err) return json(res, 500, { error: "wiki not readable" });
      res.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-cache",
      });
      res.end(data);
    });
    return;
  }
  if (req.method === "POST" && pathname === "/api/control") {
    return readJsonBody(req, config.maxBodyBytes, (err, body) => {
      if (err) return jsonBodyError(res, err);
      setAuditTarget(res, String(body.action ?? ""));
      runControl(String(body.action ?? ""), config, (ctrlErr, result) => {
        if (ctrlErr) return json(res, 400, { error: ctrlErr.message });
        json(res, 200, result);
      });
    });
  }

  notFound(res);
}
