import * as https from "node:https";

export {
  TOKEN_FILE,
  readCachedToken,
  writeCachedToken,
  readKeychainToken,
} from "../lib/token-cache.js";

// ---------------------------------------------------------------------------
// JWT helpers (no external dependencies)
// ---------------------------------------------------------------------------

export function decodeJwtPayload(token: string): Record<string, unknown> {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return {};
    const padded = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
  } catch {
    return {};
  }
}

/** Extract the auth0 user sub from a Cursor access token (e.g. "auth0|user_01KK…"). */
export function tokenSub(token: string): string | undefined {
  const p = decodeJwtPayload(token);
  return typeof p.sub === "string" ? p.sub : undefined;
}

// ---------------------------------------------------------------------------
// Cursor API
// ---------------------------------------------------------------------------

export type ModelUsage = {
  numRequests: number;
  numRequestsTotal: number;
  numTokens: number;
  maxTokenUsage: number | null;
  maxRequestUsage: number | null;
};

export type UsageData = {
  startOfMonth: string;
  models: Record<string, ModelUsage>;
};

/** Session JWTs work with /auth/usage; `crsr_…` agent API keys do not. */
export function isSessionAccessToken(token: string): boolean {
  if (!token || token.startsWith("crsr_")) return false;
  const parts = token.split(".");
  return parts.length === 3 && parts[0].length > 0 && parts[1].length > 0;
}

/** Cursor auth-error JSON must not be treated as usage/model data. */
export function isCursorAuthErrorPayload(
  raw: Record<string, unknown> | null | undefined,
): boolean {
  if (!raw || typeof raw !== "object") return false;
  const code = typeof raw.code === "string" ? raw.code : "";
  if (/unauth|not_logged|forbidden|unauthorized/i.test(code)) return true;
  const msg = typeof raw.message === "string" ? raw.message : "";
  if (/unauthenticated|not_logged_in|ERROR_NOT_LOGGED_IN/i.test(msg)) return true;
  return false;
}

/**
 * Parse /auth/usage JSON. Returns null for auth errors or malformed payloads
 * so callers never put `code`/`details` into the models map.
 */
export function parseUsageApiResponse(raw: unknown): UsageData | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (isCursorAuthErrorPayload(obj)) return null;

  const models: Record<string, ModelUsage> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (
      key === "startOfMonth" ||
      key === "code" ||
      key === "message" ||
      key === "details" ||
      key === "error"
    ) {
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (!("numRequests" in row)) continue;
    models[key] = {
      numRequests: Number(row.numRequests) || 0,
      numRequestsTotal: Number(row.numRequestsTotal) || 0,
      numTokens: Number(row.numTokens) || 0,
      maxTokenUsage:
        typeof row.maxTokenUsage === "number" ? row.maxTokenUsage : null,
      maxRequestUsage:
        typeof row.maxRequestUsage === "number" ? row.maxRequestUsage : null,
    };
  }

  // A bare auth-shaped object with no model rows is not usage data.
  if (Object.keys(models).length === 0 && !("startOfMonth" in obj)) {
    return null;
  }

  return {
    startOfMonth:
      typeof obj.startOfMonth === "string" ? obj.startOfMonth : "",
    models,
  };
}

function apiGet(path: string, token: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api2.cursor.sh",
      path,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(opts, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(null);
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => {
      req.destroy(new Error("timeout"));
    });
    req.end();
  });
}

export type ApiKeyProfile = {
  apiKeyName: string;
  createdAt: string;
  userEmail: string;
};

/** Parse `GET https://api.cursor.com/v1/me` (Basic auth with agent API key). */
export function parseApiKeyProfileResponse(raw: unknown): ApiKeyProfile | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const apiKeyName =
    typeof obj.apiKeyName === "string" ? obj.apiKeyName.trim() : "";
  const createdAt =
    typeof obj.createdAt === "string" ? obj.createdAt.trim() : "";
  const userEmail =
    typeof obj.userEmail === "string" ? obj.userEmail.trim() : "";
  if (!apiKeyName && !userEmail) return null;
  return { apiKeyName, createdAt, userEmail };
}

/**
 * Identity metadata available to agent API keys (`crsr_…`).
 * Does **not** include plan, expiry, or usage — those need a session JWT.
 */
export async function fetchApiKeyProfile(
  apiKey: string,
): Promise<ApiKeyProfile | null> {
  if (!apiKey || !apiKey.startsWith("crsr_")) return null;
  const auth = Buffer.from(`${apiKey}:`, "utf8").toString("base64");
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: "api.cursor.com",
        path: "/v1/me",
        method: "GET",
        headers: { Authorization: `Basic ${auth}` },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            resolve(parseApiKeyProfileResponse(JSON.parse(data)));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(8000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

export async function fetchAccountUsage(
  token: string,
): Promise<UsageData | null> {
  if (!isSessionAccessToken(token)) return null;
  try {
    const raw = await apiGet("/auth/usage", token);
    return parseUsageApiResponse(raw);
  } catch {
    return null;
  }
}

export type StripeProfile = {
  membershipType: string;
  subscriptionStatus: string;
  daysRemainingOnTrial: number | null;
  isTeamMember: boolean;
  isYearlyPlan: boolean;
};

/** Human-readable plan name + limits for display. */
export function describePlan(profile: StripeProfile): string {
  const { membershipType, subscriptionStatus, daysRemainingOnTrial } = profile;
  switch (membershipType) {
    case "free_trial": {
      const days = daysRemainingOnTrial ?? 0;
      return `Pro Trial (${days}d left) — unlimited fast requests`;
    }
    case "pro":
    case "pro_plus":
    case "ultra":
      return `${membershipType === "pro" ? "Pro" : membershipType === "pro_plus" ? "Pro+" : "Ultra"} — extended limits`;
    case "free":
    case "hobby":
      return "Hobby (free) — limited agent requests";
    default: {
      const parts = [membershipType, subscriptionStatus].filter(Boolean);
      return parts.length > 0 ? parts.join(" · ") : "Unknown plan";
    }
  }
}

export async function fetchStripeProfile(
  token: string,
): Promise<StripeProfile | null> {
  if (!isSessionAccessToken(token)) return null;
  try {
    const raw = (await apiGet("/auth/full_stripe_profile", token)) as Record<
      string,
      unknown
    > | null;
    if (!raw || typeof raw !== "object") return null;
    if (isCursorAuthErrorPayload(raw)) return null;
    const membershipType = String(raw.membershipType ?? "");
    const subscriptionStatus = String(raw.subscriptionStatus ?? "");
    if (!membershipType && !subscriptionStatus) return null;
    return {
      membershipType,
      subscriptionStatus,
      daysRemainingOnTrial:
        typeof raw.daysRemainingOnTrial === "number"
          ? raw.daysRemainingOnTrial
          : null,
      isTeamMember: Boolean(raw.isTeamMember),
      isYearlyPlan: Boolean(raw.isYearlyPlan),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Summary helpers
// ---------------------------------------------------------------------------

// Human-readable labels for Cursor's internal model/pool keys.
// Keys are actual identifiers from the agent binary (2026.03.20 build).
const MODEL_LABELS: Record<string, string> = {
  // ── Usage pool keys (what the /auth/usage API actually returns) ──
  "gpt-4": "Fast Premium Requests", // main premium pool (all models)

  // ── Claude Sonnet ──
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-5-20250929-v1": "Claude Sonnet 4.5",
  "claude-sonnet-4-20250514-v1": "Claude Sonnet 4",

  // ── Claude Opus ──
  "claude-opus-4-6-v1": "Claude Opus 4.6",
  "claude-opus-4-5-20251101-v1": "Claude Opus 4.5",
  "claude-opus-4-1-20250805-v1": "Claude Opus 4.1",
  "claude-opus-4-20250514-v1": "Claude Opus 4",

  // ── Claude Haiku ──
  "claude-haiku-4-5-20251001-v1": "Claude Haiku 4.5",
  "claude-3-5-haiku-20241022-v1": "Claude 3.5 Haiku",

  // ── GPT / OpenAI ──
  "gpt-5": "GPT-5",
  "gpt-4o": "GPT-4o",
  o1: "o1",
  "o3-mini": "o3-mini",

  // ── Cursor-native ──
  "cursor-small": "Cursor Small (free)",
};

function modelLabel(key: string): string {
  return MODEL_LABELS[key] ?? key;
}

export function formatUsageSummary(usage: UsageData): string[] {
  const lines: string[] = [];
  const start = usage.startOfMonth
    ? new Date(usage.startOfMonth).toLocaleDateString()
    : "?";
  lines.push(`     📅 Billing period from ${start}`);

  const entries = Object.entries(usage.models);
  if (entries.length === 0) {
    lines.push(`     🔢 No requests this billing period`);
    return lines;
  }

  // Sort: entries with limits first, then by usage descending
  const sorted = entries.sort(([, a], [, b]) => {
    if ((a.maxRequestUsage !== null) !== (b.maxRequestUsage !== null))
      return a.maxRequestUsage !== null ? -1 : 1;
    return b.numRequests - a.numRequests;
  });

  for (const [key, v] of sorted) {
    const used = v.numRequests;
    const max = v.maxRequestUsage;
    const label = modelLabel(key);
    if (max !== null && max > 0) {
      const pct = Math.round((used / max) * 100);
      const bar = makeBar(used, max, 12);
      lines.push(`     🔢 ${label}: ${used}/${max} (${pct}%) [${bar}]`);
    } else if (used > 0) {
      lines.push(`     🔢 ${label}: ${used} requests`);
    } else {
      lines.push(`     🔢 ${label}: 0 requests (unlimited)`);
    }
  }

  return lines;
}

function makeBar(used: number, max: number, width: number): string {
  const fill = Math.round((used / max) * width);
  return "█".repeat(fill) + "░".repeat(width - fill);
}
