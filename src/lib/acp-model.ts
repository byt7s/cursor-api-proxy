/**
 * ACP model selection helpers: strict resolution (no silent Auto fallback).
 */

import { debuglog } from "node:util";

import { toAcpCliModelId } from "./sdk-model-map.js";

const debugAcp = debuglog("cursor-api-proxy:acp");

export type AcpAvailableModel = { modelId: string; name: string };

export const MODEL_NOT_FOUND_CODE = "model_not_found";

export class AcpModelNotFoundError extends Error {
  readonly code = MODEL_NOT_FOUND_CODE;
  readonly requested: string;

  constructor(requested: string, detail?: string) {
    super(
      detail ??
        `Model not found or not available for this account: ${requested}`,
    );
    this.name = "AcpModelNotFoundError";
    this.requested = requested;
  }
}

/** True when the client asked for the session default / Auto router. */
export function isSessionDefaultModel(name: string | undefined): boolean {
  if (!name) return true;
  const n = name.trim().toLowerCase();
  return n === "" || n === "default" || n === "auto" || n === "default[]";
}

export function isModelNotFoundMessage(stderr: string | undefined): boolean {
  if (!stderr) return false;
  return (
    /model_not_found:/i.test(stderr) ||
    stderr.includes("AcpModelNotFoundError") ||
    /Model not found or not available/i.test(stderr)
  );
}

/** Extract a clean public message from agent stderr for model_not_found. */
export function modelNotFoundPublicMessage(
  stderr: string | undefined,
  fallbackModel?: string,
): string {
  if (!stderr?.trim()) {
    return `Model not found or not available${fallbackModel ? `: ${fallbackModel}` : ""}`;
  }
  const line =
    stderr
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /model_not_found:/i.test(l) || /Model not found/i.test(l)) ??
    stderr.trim();
  return line;
}

/**
 * Map OpenAI-style / proxy display name to Cursor ACP `modelId`.
 *
 * - Known aliases expand to parameterized CLI ids (`cursor-grok-4.5-high-fast`
 *   → `grok-4.5[effort=high,fast=true]`).
 * - With a non-empty catalog, unknown models throw {@link AcpModelNotFoundError}
 *   instead of falling back to Auto — except intentional `auto`/`default`.
 * - With an empty catalog, returns the parameterized / display id for the
 *   caller to try `session/set_config_option` (failure must still error).
 */
export function resolveAcpModelConfigValue(
  displayName: string,
  availableModels: AcpAvailableModel[] | undefined,
): string {
  const parameterized = toAcpCliModelId(displayName);
  const candidates = Array.from(
    new Set(
      [displayName, parameterized].filter(
        (v): v is string => Boolean(v && v.trim()),
      ),
    ),
  );

  if (!availableModels?.length) {
    return parameterized ?? displayName;
  }

  for (const candidate of candidates) {
    const byName = availableModels.find(
      (m) => m.name.toLowerCase() === candidate.toLowerCase(),
    );
    if (byName) return byName.modelId;
    const byId = availableModels.find(
      (m) => m.modelId.toLowerCase() === candidate.toLowerCase(),
    );
    if (byId) return byId.modelId;
  }

  if (isSessionDefaultModel(displayName)) {
    debugAcp(
      "ACP model: session default %j not listed in catalog; leaving session default",
      displayName,
    );
    return "default[]";
  }

  debugAcp(
    "ACP model: no catalog match for display name %j (tried %j)",
    displayName,
    candidates,
  );
  throw new AcpModelNotFoundError(
    displayName,
    `model_not_found: ${displayName} (not in ACP catalog; tried ${candidates.join(", ")})`,
  );
}

/**
 * Resolve + set session model. Throws {@link AcpModelNotFoundError} when the
 * model is unknown or `session/set_config_option` rejects it.
 * No-op for intentional session defaults (`auto` / `default`) when unresolved.
 */
export async function configureAcpSessionModel(args: {
  model: string | undefined;
  availableModels: AcpAvailableModel[] | undefined;
  setModel: (modelId: string) => Promise<void>;
}): Promise<void> {
  if (!args.model?.trim()) return;

  let resolvedModelId: string;
  try {
    resolvedModelId = resolveAcpModelConfigValue(
      args.model,
      args.availableModels,
    );
  } catch (err) {
    if (err instanceof AcpModelNotFoundError) throw err;
    throw new AcpModelNotFoundError(
      args.model,
      `model_not_found: ${args.model} (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (resolvedModelId === "default" || resolvedModelId === "default[]") {
    // Intentional Auto/default — leave the session as-is.
    return;
  }

  try {
    await args.setModel(resolvedModelId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new AcpModelNotFoundError(
      args.model,
      `model_not_found: ${args.model} (ACP rejected ${resolvedModelId}: ${detail})`,
    );
  }
}
