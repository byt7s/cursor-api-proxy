import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pickConfigDirForModels } from "./models.js";

describe("pickConfigDirForModels", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it("returns undefined for empty/missing dirs", () => {
    expect(pickConfigDirForModels(undefined)).toBeUndefined();
    expect(pickConfigDirForModels([])).toBeUndefined();
  });

  it("prefers a dir that has .cursor-api-key", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-models-"));
    const cliOnly = path.join(tmp, "cli");
    const apiKey = path.join(tmp, "api");
    fs.mkdirSync(cliOnly, { recursive: true });
    fs.mkdirSync(apiKey, { recursive: true });
    fs.writeFileSync(path.join(apiKey, ".cursor-api-key"), "sk-test", {
      mode: 0o600,
    });

    expect(pickConfigDirForModels([cliOnly, apiKey])).toBe(apiKey);
  });

  it("falls back to the first dir when none have an API key", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-models-"));
    const a = path.join(tmp, "a");
    const b = path.join(tmp, "b");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    expect(pickConfigDirForModels([a, b])).toBe(a);
  });
});
