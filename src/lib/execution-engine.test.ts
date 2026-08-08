import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ENGINE_FILE,
  parseExecutionEngine,
  resolveAccountEngine,
  writeAccountEngine,
} from "./execution-engine.js";

describe("execution-engine", () => {
  let tmp: string;

  afterEach(() => {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("parses engine tokens", () => {
    expect(parseExecutionEngine("sdk")).toBe("sdk");
    expect(parseExecutionEngine(" ACP ")).toBe("acp");
    expect(parseExecutionEngine("nope")).toBeUndefined();
  });

  it("defaults when no override file", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-"));
    expect(resolveAccountEngine(tmp, "acp")).toBe("acp");
    expect(resolveAccountEngine(tmp, "sdk")).toBe("sdk");
    expect(resolveAccountEngine(undefined, "sdk")).toBe("sdk");
  });

  it("prefers per-account .cursor-bridge-engine over default", () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "engine-"));
    writeAccountEngine(tmp, "sdk");
    expect(fs.readFileSync(path.join(tmp, ENGINE_FILE), "utf-8").trim()).toBe(
      "sdk",
    );
    expect(resolveAccountEngine(tmp, "acp")).toBe("sdk");
  });
});
