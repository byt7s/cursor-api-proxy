/**
 * Who may reach the sensitive dashboard APIs and `/metrics`.
 *
 * The dashboard can create and delete accounts, attach Cursor keys and reset
 * the machine id, so it should not share a credential with ordinary LLM
 * traffic. The gate therefore resolves in this order:
 *
 * 1. An `admin`-scoped key from `CURSOR_BRIDGE_API_KEYS` — always accepted.
 * 2. `CURSOR_BRIDGE_DASHBOARD_KEY`, when set — the only other way in; the
 *    legacy `CURSOR_BRIDGE_API_KEY` no longer opens the dashboard.
 * 3. Otherwise the pre-existing behaviour: `CURSOR_BRIDGE_API_KEY` when set,
 *    else loopback-only for mutations and open for sensitive reads.
 *
 * A `chat`-scoped key is refused with 403 rather than 401: the caller is
 * authenticated, it simply has the wrong scope, and saying so plainly beats
 * sending an operator hunting for a typo in their key.
 */

import type * as http from "node:http";

import {
  apiKeyFingerprint,
  matchApiKey,
  timingSafeEqualString,
  type ApiKeyEntry,
} from "./api-keys.js";
import { extractBearerToken, isLoopbackAddress } from "./http.js";

/** Actor recorded in the audit log when no key was required. */
export const LOOPBACK_ACTOR = "loopback";
/** Actor recorded when `CURSOR_BRIDGE_DASHBOARD_KEY` authenticated the call. */
export const DASHBOARD_KEY_ACTOR = "dashboard-key";
/** Actor recorded when the legacy `CURSOR_BRIDGE_API_KEY` authenticated. */
export const LEGACY_KEY_ACTOR = "bridge-api-key";

export type SensitiveAuthConfig = {
  requiredKey?: string;
  dashboardKey?: string;
  apiKeys: ApiKeyEntry[];
};

export type AuthorizedActor = {
  actor: string;
  fingerprint?: string;
};

export type AuthorizeResult =
  | ({ ok: true } & AuthorizedActor)
  | ({ ok: false; status: number; error: string } & AuthorizedActor);

export function authorizeSensitiveApi(
  req: http.IncomingMessage,
  config: SensitiveAuthConfig,
  kind: "mutate" | "sensitiveRead",
): AuthorizeResult {
  const token = extractBearerToken(req);
  const matched = matchApiKey(config.apiKeys, token);

  if (matched?.scope === "admin") {
    return {
      ok: true,
      actor: matched.label,
      fingerprint: apiKeyFingerprint(matched.key),
    };
  }

  if (config.dashboardKey) {
    if (token && timingSafeEqualString(config.dashboardKey, token)) {
      return {
        ok: true,
        actor: DASHBOARD_KEY_ACTOR,
        fingerprint: apiKeyFingerprint(config.dashboardKey),
      };
    }
    if (matched) {
      return scopeRefusal(matched);
    }
    return {
      ok: false,
      status: 401,
      error: "Authorization Bearer CURSOR_BRIDGE_DASHBOARD_KEY required",
      actor: "anonymous",
    };
  }

  if (config.requiredKey) {
    if (token && timingSafeEqualString(config.requiredKey, token)) {
      return {
        ok: true,
        actor: LEGACY_KEY_ACTOR,
        fingerprint: apiKeyFingerprint(config.requiredKey),
      };
    }
    if (matched) {
      return scopeRefusal(matched);
    }
    return {
      ok: false,
      status: 401,
      error: "Authorization Bearer CURSOR_BRIDGE_API_KEY required",
      actor: "anonymous",
    };
  }

  if (matched) {
    return scopeRefusal(matched);
  }

  if (kind === "mutate" && !isLoopbackAddress(req.socket?.remoteAddress)) {
    return {
      ok: false,
      status: 403,
      error:
        "Mutating dashboard APIs require CURSOR_BRIDGE_DASHBOARD_KEY (or CURSOR_BRIDGE_API_KEY) when not on loopback",
      actor: "anonymous",
    };
  }

  return { ok: true, actor: LOOPBACK_ACTOR };
}

function scopeRefusal(matched: ApiKeyEntry): AuthorizeResult {
  return {
    ok: false,
    status: 403,
    error: `API key "${matched.label}" has scope "${matched.scope}"; dashboard APIs need an admin-scoped key or CURSOR_BRIDGE_DASHBOARD_KEY`,
    actor: matched.label,
    fingerprint: apiKeyFingerprint(matched.key),
  };
}

/** True when at least one credential guards the dashboard. */
export function dashboardIsKeyProtected(config: SensitiveAuthConfig): boolean {
  return Boolean(
    config.dashboardKey ||
      config.requiredKey ||
      config.apiKeys.some((k) => k.scope === "admin"),
  );
}
