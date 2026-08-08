import * as crypto from "node:crypto";
import type * as http from "node:http";

import type { BridgeConfig } from "../config.js";
import { extractBearerToken, isLoopbackAddress, json } from "../http.js";
import { METRICS_CONTENT_TYPE, renderMetrics } from "../metrics.js";

export const METRICS_PATH = "/metrics";

/**
 * `/metrics` exposes account names, model ids and traffic volume, so it is
 * gated like the dashboard's sensitive reads: Bearer when `CURSOR_BRIDGE_API_KEY`
 * is set, loopback-only otherwise. `CURSOR_BRIDGE_METRICS_ENABLED=false` makes
 * the route disappear (404).
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

  if (config.requiredKey) {
    const token = Buffer.from(extractBearerToken(req) ?? "", "utf8");
    const expected = Buffer.from(config.requiredKey, "utf8");
    const match =
      token.length === expected.length &&
      crypto.timingSafeEqual(token, expected);
    if (!match) {
      return {
        ok: false,
        status: 401,
        message: "Authorization Bearer CURSOR_BRIDGE_API_KEY required",
        code: "unauthorized",
      };
    }
    return { ok: true };
  }

  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    return {
      ok: false,
      status: 403,
      message:
        "Metrics are loopback-only unless CURSOR_BRIDGE_API_KEY is set",
      code: "forbidden",
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
