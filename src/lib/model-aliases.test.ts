import { describe, expect, it } from "vitest";

import {
  applyModelAliases,
  normalizeModelAliases,
  parseModelAliasesJson,
} from "./model-aliases.js";

describe("normalizeModelAliases", () => {
  it("lowercases keys and trims targets", () => {
    expect(
      normalizeModelAliases({
        " GPT-4o ": " composer-2 ",
        "Claude-3-5-Sonnet": "sonnet-4.5",
      }),
    ).toEqual({
      "gpt-4o": "composer-2",
      "claude-3-5-sonnet": "sonnet-4.5",
    });
  });

  it("drops non-string values and empty keys", () => {
    expect(
      normalizeModelAliases({
        "": "x",
        ok: "y",
        bad: 1 as unknown as string,
      }),
    ).toEqual({ ok: "y" });
  });
});

describe("parseModelAliasesJson", () => {
  it("returns empty map when unset", () => {
    expect(parseModelAliasesJson(undefined)).toEqual({});
    expect(parseModelAliasesJson("")).toEqual({});
    expect(parseModelAliasesJson("   ")).toEqual({});
  });

  it("parses a JSON object string", () => {
    expect(
      parseModelAliasesJson('{"gpt-4o":"composer-2","Claude":"sonnet-4.5"}'),
    ).toEqual({
      "gpt-4o": "composer-2",
      claude: "sonnet-4.5",
    });
  });

  it("rejects invalid JSON and non-objects", () => {
    expect(() => parseModelAliasesJson("{")).toThrow(/JSON object/);
    expect(() => parseModelAliasesJson("[]")).toThrow(/JSON object/);
    expect(() => parseModelAliasesJson('{"a":1}')).toThrow(/must be a string/);
  });
});

describe("applyModelAliases", () => {
  const aliases = {
    "gpt-4o": "composer-2",
    "claude-3-5-sonnet": "sonnet-4.5",
    broken: "",
  };

  it("passes through when no alias matches", () => {
    expect(applyModelAliases("composer-2", aliases)).toEqual({
      ok: true,
      model: "composer-2",
      aliased: false,
    });
  });

  it("rewrites a matching client id (case-insensitive)", () => {
    expect(applyModelAliases("GPT-4o", aliases)).toEqual({
      ok: true,
      model: "composer-2",
      aliased: true,
      aliasKey: "gpt-4o",
    });
  });

  it("never aliases the default sentinel", () => {
    expect(applyModelAliases("default", { default: "composer-2" })).toEqual({
      ok: true,
      model: "default",
      aliased: false,
    });
  });

  it("returns 400-shaped error for an empty alias target", () => {
    expect(applyModelAliases("broken", aliases)).toEqual({
      ok: false,
      code: "invalid_model_alias",
      message: 'Model alias "broken" maps to an empty target',
      aliasKey: "broken",
    });
  });

  it("does not re-alias the target (one hop)", () => {
    expect(
      applyModelAliases("gpt-4o", {
        "gpt-4o": "claude-3-5-sonnet",
        "claude-3-5-sonnet": "sonnet-4.5",
      }),
    ).toEqual({
      ok: true,
      model: "claude-3-5-sonnet",
      aliased: true,
      aliasKey: "gpt-4o",
    });
  });
});
