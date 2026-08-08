export type SdkModelParam = { id: string; value: string };

export type SdkModelSelection = {
  id: string;
  params?: SdkModelParam[];
};

const GROK_SDK_MODEL_ID = "grok-4.5";

type GrokVariant = {
  cliModel: string;
  effort: "low" | "medium" | "high";
  fast: boolean;
};

const GROK_VARIANTS: GrokVariant[] = [
  { cliModel: "cursor-grok-4.5-low", effort: "low", fast: false },
  { cliModel: "cursor-grok-4.5-medium", effort: "medium", fast: false },
  { cliModel: "cursor-grok-4.5-high", effort: "high", fast: false },
  { cliModel: "cursor-grok-4.5-low-fast", effort: "low", fast: true },
  { cliModel: "cursor-grok-4.5-medium-fast", effort: "medium", fast: true },
  { cliModel: "cursor-grok-4.5-high-fast", effort: "high", fast: true },
];

const COMPOSER_MODELS = new Map<string, SdkModelSelection>([
  ["composer-2.5", { id: "composer-2.5", params: [{ id: "fast", value: "false" }] }],
  [
    "composer-2.5-fast",
    { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
  ],
  ["composer-2", { id: "composer-2", params: [{ id: "fast", value: "false" }] }],
  ["composer-2-fast", { id: "composer-2", params: [{ id: "fast", value: "true" }] }],
]);

const byCliModel = new Map<string, SdkModelSelection>(COMPOSER_MODELS);
for (const v of GROK_VARIANTS) {
  byCliModel.set(v.cliModel, {
    id: GROK_SDK_MODEL_ID,
    params: [
      { id: "effort", value: v.effort },
      { id: "fast", value: String(v.fast) },
    ],
  });
}

/**
 * Flat proxy/CLI model id → parameterized `@cursor/sdk` selection.
 * Unknown ids pass through unparameterized.
 */
export function resolveSdkModel(
  cursorModel: string | undefined,
): SdkModelSelection | undefined {
  const key = cursorModel?.trim().toLowerCase();
  if (!key) return undefined;
  return byCliModel.get(key) ?? { id: key };
}

/**
 * Format an SDK selection as a Cursor CLI/ACP model id, e.g.
 * `grok-4.5[effort=high,fast=true]`.
 */
export function formatParameterizedCliModel(
  selection: SdkModelSelection,
): string {
  if (!selection.params?.length) return selection.id;
  const body = selection.params.map((p) => `${p.id}=${p.value}`).join(",");
  return `${selection.id}[${body}]`;
}

/**
 * Map flat proxy aliases (`cursor-grok-4.5-high-fast`, `composer-2-fast`) to the
 * parameterized id ACP/CLI catalogs expect. Returns undefined when the input is
 * empty; unknown ids are returned unchanged.
 */
export function toAcpCliModelId(
  cursorModel: string | undefined,
): string | undefined {
  const trimmed = cursorModel?.trim();
  if (!trimmed) return undefined;
  const selection = resolveSdkModel(trimmed);
  if (!selection) return undefined;
  // Only rewrite when we have an explicit alias entry (params present or
  // composer map hit). Unknown passthrough stays as the original casing.
  const key = trimmed.toLowerCase();
  if (!byCliModel.has(key)) return trimmed;
  return formatParameterizedCliModel(selection);
}
