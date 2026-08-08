/**
 * Opt-in CORS (`CURSOR_BRIDGE_CORS_ORIGINS`).
 *
 * The proxy is a localhost service by default, so cross-origin access is off
 * unless an operator lists origins. `*` is accepted for the "any browser app
 * on my machine" case; otherwise only exact origin matches are echoed back,
 * and credentials are never allowed (the dashboard key travels in a header,
 * not a cookie).
 */

import type * as http from "node:http";

const ALLOWED_HEADERS = "authorization, content-type, x-api-key";
const ALLOWED_METHODS = "GET, POST, PUT, DELETE, OPTIONS";

export function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

/** Headers to attach for `origin`, or `null` when the request is not allowed. */
export function corsHeadersFor(
  origin: string | undefined,
  allowedOrigins: string[],
): Record<string, string> | null {
  if (allowedOrigins.length === 0 || !origin) return null;
  const normalized = origin.replace(/\/$/, "");
  const wildcard = allowedOrigins.includes("*");
  if (!wildcard && !allowedOrigins.includes(normalized)) return null;
  return {
    "access-control-allow-origin": wildcard ? "*" : normalized,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-allow-methods": ALLOWED_METHODS,
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

function headerValue(
  req: http.IncomingMessage,
  name: string,
): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

/**
 * Attaches the allow headers to `res` when the origin is permitted. Returns
 * true when this was a preflight that has already been answered with 204.
 */
export function applyCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins: string[],
): { preflightHandled: boolean } {
  const headers = corsHeadersFor(headerValue(req, "origin"), allowedOrigins);
  if (headers) {
    for (const [name, value] of Object.entries(headers)) {
      res.setHeader(name, value);
    }
  }

  if (req.method === "OPTIONS") {
    res.writeHead(headers ? 204 : 403, { "content-length": 0 });
    res.end();
    return { preflightHandled: true };
  }

  return { preflightHandled: false };
}
