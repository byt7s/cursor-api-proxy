import { beforeEach, describe, expect, it, vi } from "vitest";

import { initAccountPool } from "./account-pool.js";
import { runSyncWithAccountFailover } from "./account-failover.js";
import {
  bindSessionAffinity,
  clearSessionAffinity,
  getSessionAffinity,
  resetSessionAffinityForTests,
} from "./session-affinity.js";

vi.mock("./request-log.js", () => ({
  logAccountAssigned: vi.fn(),
}));

describe("failover clears session affinity for context replay", () => {
  beforeEach(() => {
    resetSessionAffinityForTests();
    initAccountPool(["/acc/a", "/acc/b"]);
    bindSessionAffinity("conv-1", {
      configDir: "/acc/a",
      agentId: "agent_a",
      engine: "sdk",
    });
  });

  it("pins preferred account then clears affinity on rate-limit failover", async () => {
    let attempts = 0;
    const seen: Array<string | undefined> = [];
    const outcome = await runSyncWithAccountFailover(
      async (configDir) => {
        seen.push(configDir);
        attempts += 1;
        if (attempts === 1) {
          return { code: 1, stdout: "", stderr: "429 rate limit exceeded" };
        }
        return { code: 0, stdout: "ok", stderr: "" };
      },
      undefined,
      {
        preferConfigDir: "/acc/a",
        onAccountFailover: () => clearSessionAffinity("conv-1"),
      },
    );

    expect(outcome.status).toBe("ok");
    expect(seen[0]).toBe("/acc/a");
    expect(seen[1]).toBe("/acc/b");
    expect(getSessionAffinity("conv-1")).toBeUndefined();
  });

  it("uses preferred account when usable", async () => {
    const seen: Array<string | undefined> = [];
    const outcome = await runSyncWithAccountFailover(
      async (configDir) => {
        seen.push(configDir);
        return { code: 0, stdout: "ok", stderr: "" };
      },
      undefined,
      { preferConfigDir: "/acc/a" },
    );
    expect(outcome.status).toBe("ok");
    expect(seen[0]).toBe("/acc/a");
  });
});
