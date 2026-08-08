import { describe, expect, it, vi } from "vitest";

import {
  AcpModelNotFoundError,
  configureAcpSessionModel,
  isModelNotFoundMessage,
  isSessionDefaultModel,
  resolveAcpModelConfigValue,
} from "./acp-model.js";

describe("resolveAcpModelConfigValue (strict)", () => {
  it("maps cursor-grok alias when catalog is empty", () => {
    expect(resolveAcpModelConfigValue("cursor-grok-4.5-high-fast", undefined)).toBe(
      "grok-4.5[effort=high,fast=true]",
    );
  });

  it("throws when a non-default model is missing from the catalog", () => {
    expect(() =>
      resolveAcpModelConfigValue("nope-model", [
        { modelId: "composer-2[]", name: "composer-2" },
      ]),
    ).toThrow(AcpModelNotFoundError);
    expect(() =>
      resolveAcpModelConfigValue("nope-model", [
        { modelId: "composer-2[]", name: "composer-2" },
      ]),
    ).toThrow(/model_not_found:/);
  });

  it("allows intentional auto/default to stay on session default", () => {
    expect(
      resolveAcpModelConfigValue("auto", [
        { modelId: "composer-2[]", name: "composer-2" },
      ]),
    ).toBe("default[]");
  });

  it("matches parameterized grok by modelId", () => {
    expect(
      resolveAcpModelConfigValue("cursor-grok-4.5-high-fast", [
        {
          modelId: "grok-4.5[effort=high,fast=true]",
          name: "grok-4.5",
        },
      ]),
    ).toBe("grok-4.5[effort=high,fast=true]");
  });
});

describe("configureAcpSessionModel", () => {
  it("sets the resolved model id", async () => {
    const setModel = vi.fn(async () => undefined);
    await configureAcpSessionModel({
      model: "cursor-grok-4.5-high-fast",
      availableModels: undefined,
      setModel,
    });
    expect(setModel).toHaveBeenCalledWith("grok-4.5[effort=high,fast=true]");
  });

  it("does not call setModel for unresolved session defaults", async () => {
    const setModel = vi.fn(async () => undefined);
    await configureAcpSessionModel({
      model: "auto",
      availableModels: [{ modelId: "x[]", name: "other" }],
      setModel,
    });
    expect(setModel).not.toHaveBeenCalled();
  });

  it("surfaces ACP rejection as model_not_found", async () => {
    await expect(
      configureAcpSessionModel({
        model: "composer-2",
        availableModels: undefined,
        setModel: async () => {
          throw new Error("unknown config value");
        },
      }),
    ).rejects.toMatchObject({
      name: "AcpModelNotFoundError",
      message: expect.stringContaining("model_not_found:"),
    });
  });

  it("propagates catalog misses without calling setModel", async () => {
    const setModel = vi.fn(async () => undefined);
    await expect(
      configureAcpSessionModel({
        model: "missing",
        availableModels: [{ modelId: "x[]", name: "composer-2" }],
        setModel,
      }),
    ).rejects.toBeInstanceOf(AcpModelNotFoundError);
    expect(setModel).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("detects session defaults", () => {
    expect(isSessionDefaultModel("auto")).toBe(true);
    expect(isSessionDefaultModel("DEFAULT")).toBe(true);
    expect(isSessionDefaultModel("composer-2")).toBe(false);
  });

  it("detects model_not_found stderr", () => {
    expect(isModelNotFoundMessage("model_not_found: foo")).toBe(true);
    expect(isModelNotFoundMessage("rate limited")).toBe(false);
  });
});
