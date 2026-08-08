import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isRateLimited,
  runStreamWithAccountFailover,
  runSyncWithAccountFailover,
} from "./account-failover.js";
import {
  getAccountStats,
  initAccountPool,
  reportAccountDisabled,
  reportRateLimit,
} from "./account-pool.js";
import { AdmissionCapacityError } from "./admission.js";
import { AcpWorkerBusyError } from "./acp-pool.js";

describe("isRateLimited", () => {
  it("detects common rate-limit stderr patterns", () => {
    expect(isRateLimited("Error: 429 Too Many Requests")).toBe(true);
    expect(isRateLimited("rate limit exceeded")).toBe(true);
    expect(isRateLimited("too many requests")).toBe(true);
    expect(isRateLimited("some other failure")).toBe(false);
  });
});

describe("runSyncWithAccountFailover", () => {
  afterEach(() => {
    initAccountPool([]);
  });

  it("returns success from the first available account", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async (configDir: string | undefined) => ({
      code: 0,
      stdout: `ok:${configDir}`,
      stderr: "",
    }));

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.configDir).toBe("/a");
    expect(outcome.result.stdout).toBe("ok:/a");
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("silently retries another account on rate limit", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async (configDir: string | undefined) => {
      if (configDir === "/a") {
        return { code: 1, stdout: "", stderr: "Error 429 rate limit" };
      }
      return { code: 0, stdout: "from-b", stderr: "" };
    });

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.configDir).toBe("/b");
    expect(outcome.result.stdout).toBe("from-b");
    expect(runOnce).toHaveBeenCalledTimes(2);

    const stats = getAccountStats();
    expect(stats.find((s) => s.configDir === "/a")?.isRateLimited).toBe(true);
    expect(stats.find((s) => s.configDir === "/b")?.totalSuccess).toBe(1);
  });

  it("returns all_rate_limited when every account is cooling down", async () => {
    initAccountPool(["/a", "/b"]);
    reportRateLimit("/a", 60_000);
    reportRateLimit("/b", 60_000);

    const runOnce = vi.fn(async () => ({
      code: 0,
      stdout: "should-not-run",
      stderr: "",
    }));

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("all_rate_limited");
    expect(runOnce).not.toHaveBeenCalled();
  });

  it("quarantines plan-upgrade accounts and retries another", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async (configDir: string | undefined) => {
      if (configDir === "/a") {
        return {
          code: 0,
          stdout: "Upgrade your plan to continue",
          stderr: "",
        };
      }
      return { code: 0, stdout: "from-b", stderr: "" };
    });

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.configDir).toBe("/b");
    expect(runOnce).toHaveBeenCalledTimes(2);
    expect(getAccountStats().find((s) => s.configDir === "/a")?.isDisabled).toBe(
      true,
    );
  });

  it("returns all_rate_limited after every account hits rate limit", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "too many requests",
    }));

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("all_rate_limited");
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-rate-limit errors", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async () => ({
      code: 1,
      stdout: "",
      stderr: "boom",
    }));

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("error");
    expect(runOnce).toHaveBeenCalledTimes(1);
  });

  it("retries next account on AdmissionCapacityError", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async (configDir: string | undefined) => {
      if (configDir === "/a") throw new AdmissionCapacityError(1000);
      return { code: 0, stdout: "from-b", stderr: "" };
    });

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.configDir).toBe("/b");
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("retries next account on AcpWorkerBusyError", async () => {
    initAccountPool(["/a", "/b"]);
    const runOnce = vi.fn(async (configDir: string | undefined) => {
      if (configDir === "/a") throw new AcpWorkerBusyError("/a");
      return { code: 0, stdout: "from-b", stderr: "" };
    });

    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.configDir).toBe("/b");
    expect(runOnce).toHaveBeenCalledTimes(2);
  });

  it("returns all_disabled when every account is quarantined", async () => {
    initAccountPool(["/a", "/b"]);
    reportAccountDisabled("/a", "plan_upgrade");
    reportAccountDisabled("/b", "plan_upgrade");
    const runOnce = vi.fn(async () => ({
      code: 0,
      stdout: "nope",
      stderr: "",
    }));
    const outcome = await runSyncWithAccountFailover(runOnce);
    expect(outcome.status).toBe("all_disabled");
    expect(runOnce).not.toHaveBeenCalled();
  });
});

describe("runStreamWithAccountFailover", () => {
  afterEach(() => {
    initAccountPool([]);
  });

  it("retries before commit when the first account is rate-limited", async () => {
    initAccountPool(["/a", "/b"]);
    const commits: string[] = [];
    const chunks: string[] = [];

    const outcome = await runStreamWithAccountFailover({
      onCommit: () => commits.push("commit"),
      onChunk: (c) => chunks.push(c),
      runOnce: async (configDir, onChunk) => {
        if (configDir === "/a") {
          return { code: 1, stderr: "429 rate limit" };
        }
        onChunk("hello");
        return { code: 0, stderr: "" };
      },
    });

    expect(outcome.status).toBe("ok");
    expect(commits).toEqual(["commit"]);
    expect(chunks).toEqual(["hello"]);
    if (outcome.status === "ok") {
      expect(outcome.configDir).toBe("/b");
      expect(outcome.committed).toBe(true);
    }
  });

  it("returns all_rate_limited without committing when no account works", async () => {
    initAccountPool(["/a", "/b"]);
    const commits: string[] = [];

    const outcome = await runStreamWithAccountFailover({
      onCommit: () => commits.push("commit"),
      onChunk: () => {},
      runOnce: async () => ({ code: 1, stderr: "rate limit exceeded" }),
    });

    expect(outcome.status).toBe("all_rate_limited");
    expect(commits).toEqual([]);
    if (outcome.status === "all_rate_limited") {
      expect(outcome.committed).toBe(false);
    }
  });
});
