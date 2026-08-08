import { describe, expect, it } from "vitest";

import {
  formatParameterizedCliModel,
  resolveSdkModel,
  toAcpCliModelId,
} from "./sdk-model-map.js";

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

describe("toAcpCliModelId", () => {
  it("maps cursor-grok-4.5-high-fast to parameterized ACP/CLI id", () => {
    expect(toAcpCliModelId("cursor-grok-4.5-high-fast")).toBe(
      "grok-4.5[effort=high,fast=true]",
    );
  });

  it("maps composer-2-fast", () => {
    expect(toAcpCliModelId("composer-2-fast")).toBe(
      "composer-2[fast=true]",
    );
  });

  it("leaves unknown ids unchanged", () => {
    expect(toAcpCliModelId("claude-4-sonnet")).toBe("claude-4-sonnet");
  });

  it("formats selection helpers", () => {
    expect(
      formatParameterizedCliModel({
        id: "grok-4.5",
        params: [
          { id: "effort", value: "high" },
          { id: "fast", value: "true" },
        ],
      }),
    ).toBe("grok-4.5[effort=high,fast=true]");
  });
});
