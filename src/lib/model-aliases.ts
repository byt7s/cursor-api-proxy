/**
 * Operator-configured client model id → Cursor model id aliases.
 *
 * Applied early in request model resolution (after sticky/default, before the
 * Anthropic/SDK maps). One hop only — alias targets are not re-aliased.
 */

export type ModelAliasMap = Record<string, string>;

export type AliasApplyOk = {
  ok: true;
  /** Model id after alias rewrite (or the original when no alias matched). */
  model: string;
  aliased: boolean;
  /** Alias key that matched, when `aliased`. */
  aliasKey?: string;
};

export type AliasApplyErr = {
  ok: false;
  code: "invalid_model_alias";
  message: string;
  aliasKey: string;
};

export type AliasApplyResult = AliasApplyOk | AliasApplyErr;

/** Normalize a map from config/env: lowercased keys, trimmed non-empty targets. */
export function normalizeModelAliases(
  raw: Record<string, unknown> | undefined | null,
): ModelAliasMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: ModelAliasMap = {};
  for (const [key, value] of Object.entries(raw)) {
    const k = key.trim().toLowerCase();
    if (!k) continue;
    if (typeof value !== "string") continue;
    out[k] = value.trim();
  }
  return out;
}

/**
 * Parse `CURSOR_BRIDGE_MODEL_ALIASES` JSON object string.
 * Returns empty map when unset; throws on invalid JSON / non-object.
 */
export function parseModelAliasesJson(raw: string | undefined): ModelAliasMap {
  if (raw == null || !raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `CURSOR_BRIDGE_MODEL_ALIASES must be a JSON object: ${detail}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CURSOR_BRIDGE_MODEL_ALIASES must be a JSON object");
  }
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(
        `CURSOR_BRIDGE_MODEL_ALIASES["${key}"] must be a string`,
      );
    }
  }
  return normalizeModelAliases(parsed as Record<string, unknown>);
}

/**
 * Rewrite `requested` when it matches an alias key.
 * Empty / whitespace-only targets → clear error (unknown alias target).
 */
export function applyModelAliases(
  requested: string | undefined,
  aliases: ModelAliasMap,
): AliasApplyResult {
  if (!requested || !requested.trim()) {
    return { ok: true, model: requested ?? "", aliased: false };
  }
  // "default" is the ACP session sentinel — never alias it.
  if (requested.trim() === "default") {
    return { ok: true, model: "default", aliased: false };
  }
  if (!aliases || Object.keys(aliases).length === 0) {
    return { ok: true, model: requested, aliased: false };
  }

  const key = requested.trim().toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(aliases, key)) {
    return { ok: true, model: requested, aliased: false };
  }

  const target = aliases[key]!;
  if (!target) {
    return {
      ok: false,
      code: "invalid_model_alias",
      message: `Model alias "${requested}" maps to an empty target`,
      aliasKey: key,
    };
  }

  return {
    ok: true,
    model: target,
    aliased: true,
    aliasKey: key,
  };
}
