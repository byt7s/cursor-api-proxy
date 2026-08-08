import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  accountAllowsModel,
  MODELS_FILE,
  readAccountAllowedModels,
  writeAccountAllowedModels,
} from "./account-models.js";

describe("account-models allowlist file", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("treats missing and empty files as unrestricted", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-models-"));
    expect(readAccountAllowedModels(dir)).toBeUndefined();
    expect(accountAllowsModel(dir, "composer-2")).toBe(true);

    fs.writeFileSync(path.join(dir, MODELS_FILE), "# only comments\n\n", "utf8");
    expect(readAccountAllowedModels(dir)).toBeUndefined();
    expect(accountAllowsModel(dir, "composer-2")).toBe(true);
  });

  it("parses one id per line with # comments", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-models-"));
    fs.writeFileSync(
      path.join(dir, MODELS_FILE),
      "# comment\ncomposer-2\nsonnet-4.6  # note\n\n",
      "utf8",
    );
    expect(readAccountAllowedModels(dir)).toEqual(["composer-2", "sonnet-4.6"]);
    expect(accountAllowsModel(dir, "Composer-2")).toBe(true);
    expect(accountAllowsModel(dir, "opus-4.6")).toBe(false);
  });

  it("writes and clears the allowlist file", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "acct-models-"));
    writeAccountAllowedModels(dir, ["composer-2", "sonnet-4.6"]);
    expect(fs.existsSync(path.join(dir, MODELS_FILE))).toBe(true);
    expect(readAccountAllowedModels(dir)).toEqual(["composer-2", "sonnet-4.6"]);

    writeAccountAllowedModels(dir, []);
    expect(fs.existsSync(path.join(dir, MODELS_FILE))).toBe(false);
    expect(readAccountAllowedModels(dir)).toBeUndefined();
  });
});
