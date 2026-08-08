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
