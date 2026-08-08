import { describe, expect, it } from "vitest";

import { resolveSdkModel } from "./sdk-model-map.js";

describe("resolveSdkModel", () => {
  it("maps grok flat ids to parameterized SDK selection", () => {
    expect(resolveSdkModel("cursor-grok-4.5-high-fast")).toEqual({
      id: "grok-4.5",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
  });

  it("maps composer-2.5-fast", () => {
    expect(resolveSdkModel("composer-2.5-fast")).toEqual({
      id: "composer-2.5",
      params: [{ id: "fast", value: "true" }],
    });
  });

  it("passes unknown ids through", () => {
    expect(resolveSdkModel("custom-model")).toEqual({ id: "custom-model" });
  });

  it("returns undefined for empty", () => {
    expect(resolveSdkModel(undefined)).toBeUndefined();
    expect(resolveSdkModel("  ")).toBeUndefined();
  });
});
