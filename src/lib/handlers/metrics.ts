import type * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import { authorizeSensitiveApi } from "../dashboard-auth.js";
import { json } from "../http.js";
import { METRICS_CONTENT_TYPE, renderMetrics } from "../metrics.js";

export const METRICS_PATH = "/metrics";

/**
 * `/metrics` exposes account names, model ids and traffic volume, so it shares
 * the dashboard's sensitive-read gate: an admin-scoped key or the dedicated
 * dashboard key when either is configured, the legacy `CURSOR_BRIDGE_API_KEY`
 * otherwise, and loopback-only when nothing is set.
 * `CURSOR_BRIDGE_METRICS_ENABLED=false` makes the route disappear (404).
 */
export function authorizeMetrics(
  req: http.IncomingMessage,
  config: BridgeConfig,
): { ok: true } | { ok: false; status: number; message: string; code: string } {
  if (!config.metricsEnabled) {
    return {
      ok: false,
      status: 404,
      message: "Metrics endpoint is disabled (CURSOR_BRIDGE_METRICS_ENABLED)",
      code: "not_found",
    };
  }

  // Metrics are a read, but they leak enough to deserve the mutate-grade
  // loopback check when no key is configured at all.
  const auth = authorizeSensitiveApi(req, config, "mutate");
  if (!auth.ok) {
    return {
      ok: false,
      status: auth.status,
      message: auth.error,
      code: auth.status === 401 ? "unauthorized" : "forbidden",
    };
  }
  return { ok: true };
}

export function handleMetrics(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  opts: { version: string; config: BridgeConfig },
): void {
  const auth = authorizeMetrics(req, opts.config);
  if (!auth.ok) {
    json(res, auth.status, {
      error: { message: auth.message, code: auth.code },
    });
    return;
  }

  const body = renderMetrics({ version: opts.version });
  res.writeHead(200, {
    "content-type": METRICS_CONTENT_TYPE,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}
