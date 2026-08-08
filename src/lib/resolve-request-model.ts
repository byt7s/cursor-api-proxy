/**
 * Shared chat/messages/responses model pipeline:
 * normalize → sticky/default → operator aliases → Anthropic/Cursor map.
 */

import type { BridgeConfig } from "./config.js";
import { applyModelAliases } from "./model-aliases.js";
import {
  resolveModelWithoutCatalog,
  type ModelResolutionDecision,
} from "./model-map.js";
import { normalizeModelId } from "./openai.js";
import { rememberResolvedModel, resolveModel } from "./resolve-model.js";

export type ResolveRequestModelOk = {
  ok: true;
  /** Client-facing model id (pre-alias, after sticky/default). */
  displayModel: string;
  /** Final Cursor model id used for execution. */
  cursorModel: string;
  decision: ModelResolutionDecision;
};

export type ResolveRequestModelErr = {
  ok: false;
  status: 400;
  body: {
    error: {
      message: string;
      code: "invalid_model_alias";
      alias?: string;
    };
  };
};

export type ResolveRequestModelResult =
  | ResolveRequestModelOk
  | ResolveRequestModelErr;

export function resolveRequestModel(
  rawModel: string | undefined,
  lastRequestedModelRef: { current?: string },
  config: BridgeConfig,
): ResolveRequestModelResult {
  const requested = normalizeModelId(rawModel);
  const model = resolveModel(requested, lastRequestedModelRef, config);
  const alias = applyModelAliases(model, config.modelAliases);
  if (!alias.ok) {
    return {
      ok: false,
      status: 400,
      body: {
        error: {
          message: alias.message,
          code: alias.code,
          alias: alias.aliasKey,
        },
      },
    };
  }

  const decision = resolveModelWithoutCatalog({
    requested: alias.model,
    defaultModel: config.defaultModel,
  });
  const cursorModel = decision.final;
  rememberResolvedModel(cursorModel, lastRequestedModelRef);

  const displayModel =
    decision.requestedWasDefault && config.defaultModel !== "default"
      ? config.defaultModel
      : model;

  return { ok: true, displayModel, cursorModel, decision };
}
