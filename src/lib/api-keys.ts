/**
 * Inbound API keys for the proxy.
 *
 * Historically a single `CURSOR_BRIDGE_API_KEY` gated everything, including
 * the dashboard's account mutations. `CURSOR_BRIDGE_API_KEYS` adds a list of
 * labelled, scoped keys so a CI client can be limited to LLM traffic while an
 * operator key keeps admin access:
 *
 *     CURSOR_BRIDGE_API_KEYS="ci:chat:sk-one,ops:admin:sk-two"
 *
 * Raw key values never leave this module: everything downstream (`/api/config`,
 * status, the audit log) sees only the label, the scope and a short SHA-256
 * fingerprint.
 */

import * as crypto from "node:crypto";

export const API_KEY_SCOPES = ["chat", "admin"] as const;

/** `chat` reaches the LLM routes; `admin` also reaches dashboard APIs. */
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type ApiKeyEntry = {
  label: string;
  scope: ApiKeyScope;
  key: string;
};

/** Everything about a key that is safe to hand to a browser or a log line. */
export type ApiKeyDescriptor = {
  label: string;
  scope: ApiKeyScope;
  fingerprint: string;
};

/** Label used for the legacy single-key variable. */
export const LEGACY_API_KEY_LABEL = "default";

export function isApiKeyScope(value: string): value is ApiKeyScope {
  return (API_KEY_SCOPES as ReadonlyArray<string>).includes(value);
}

/** First 6 hex chars of the SHA-256 digest — identifies a key, cannot reveal it. */
export function apiKeyFingerprint(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 6);
}

export function describeApiKey(entry: ApiKeyEntry): ApiKeyDescriptor {
  return {
    label: entry.label,
    scope: entry.scope,
    fingerprint: apiKeyFingerprint(entry.key),
  };
}

export function describeApiKeys(entries: ApiKeyEntry[]): ApiKeyDescriptor[] {
  return entries.map(describeApiKey);
}

export type ParsedApiKeys = {
  entries: ApiKeyEntry[];
  /** Malformed items are skipped with a warning rather than failing startup. */
  warnings: string[];
};

/**
 * Parses `label:scope:key` items separated by commas. The key itself may
 * contain `:` (Cursor keys do not, but tokens generally can), so only the
 * first two separators are structural.
 */
export function parseApiKeys(raw: string | undefined): ParsedApiKeys {
  const entries: ApiKeyEntry[] = [];
  const warnings: string[] = [];
  if (!raw || !raw.trim()) return { entries, warnings };

  for (const item of raw.split(",")) {
    const spec = item.trim();
    if (!spec) continue;

    const firstSep = spec.indexOf(":");
    const secondSep = firstSep < 0 ? -1 : spec.indexOf(":", firstSep + 1);
    if (firstSep <= 0 || secondSep < 0) {
      warnings.push(
        `CURSOR_BRIDGE_API_KEYS: ignoring "${redactSpec(spec)}" — expected label:scope:key`,
      );
      continue;
    }

    const label = spec.slice(0, firstSep).trim();
    const scope = spec.slice(firstSep + 1, secondSep).trim().toLowerCase();
    const key = spec.slice(secondSep + 1).trim();

    if (!label) {
      warnings.push("CURSOR_BRIDGE_API_KEYS: ignoring entry with empty label");
      continue;
    }
    if (!isApiKeyScope(scope)) {
      warnings.push(
        `CURSOR_BRIDGE_API_KEYS: ignoring "${label}" — unknown scope "${scope}" (expected chat or admin)`,
      );
      continue;
    }
    if (!key) {
      warnings.push(
        `CURSOR_BRIDGE_API_KEYS: ignoring "${label}" — empty key value`,
      );
      continue;
    }
    if (entries.some((e) => e.label === label)) {
      warnings.push(
        `CURSOR_BRIDGE_API_KEYS: ignoring duplicate label "${label}"`,
      );
      continue;
    }

    entries.push({ label, scope, key });
  }

  return { entries, warnings };
}

/** Keeps a malformed entry identifiable in a warning without echoing a secret. */
function redactSpec(spec: string): string {
  const head = spec.split(":")[0] ?? spec;
  return head.slice(0, 24);
}

export function timingSafeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Returns the entry whose key equals `token`, comparing in constant time. */
export function matchApiKey(
  entries: ApiKeyEntry[],
  token: string | undefined,
): ApiKeyEntry | undefined {
  if (!token) return undefined;
  for (const entry of entries) {
    if (timingSafeEqualString(entry.key, token)) return entry;
  }
  return undefined;
}

/**
 * Merges the legacy single key with the scoped list. The legacy key keeps
 * scope `chat` so upgrading does not silently widen it; the dashboard gate
 * still honours it explicitly for back-compat (see `authorizeDashboardApi`).
 */
export function buildApiKeyRegistry(
  legacyKey: string | undefined,
  scoped: ApiKeyEntry[],
): ApiKeyEntry[] {
  const entries: ApiKeyEntry[] = [];
  if (legacyKey) {
    entries.push({
      label: LEGACY_API_KEY_LABEL,
      scope: "chat",
      key: legacyKey,
    });
  }
  for (const entry of scoped) {
    if (entries.some((e) => timingSafeEqualString(e.key, entry.key))) continue;
    entries.push(entry);
  }
  return entries;
}
