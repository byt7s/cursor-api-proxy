import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  admitAgentRun,
  configureAdmission,
  getAdmissionSnapshot,
  resetAdmissionForTests,
} from "./admission.js";

describe("admitAgentRun", () => {
  beforeEach(() => {
    resetAdmissionForTests();
    configureAdmission({
      maxConcurrentRuns: 2,
      maxConcurrentRunsPerAccount: 1,
      waitMs: 50,
    });
  });

  afterEach(() => {
    resetAdmissionForTests();
  });

  it("grants up to global max then rejects", async () => {
    const a = await admitAgentRun("acc-a", { waitMs: 0 });
    const b = await admitAgentRun("acc-b", { waitMs: 0 });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    const c = await admitAgentRun("acc-c", { waitMs: 0 });
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c).toMatchObject({
        reason: "capacity",
        retryAfterMs: expect.any(Number),
      });
    }
    if (a.ok) a.release();
    if (b.ok) b.release();
  });

  it("enforces per-account cap of 1", async () => {
    configureAdmission({
      maxConcurrentRuns: 4,
      maxConcurrentRunsPerAccount: 1,
      waitMs: 0,
    });
    const first = await admitAgentRun("same");
    expect(first.ok).toBe(true);
    const second = await admitAgentRun("same", { waitMs: 0 });
    expect(second.ok).toBe(false);
    if (first.ok) first.release();
    const third = await admitAgentRun("same", { waitMs: 0 });
    expect(third.ok).toBe(true);
    if (third.ok) third.release();
  });

  it("release is idempotent and frees capacity", async () => {
    configureAdmission({
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerAccount: 1,
      waitMs: 0,
    });
    const a = await admitAgentRun("x");
    expect(a.ok).toBe(true);
    if (a.ok) {
      a.release();
      a.release();
    }
    expect(getAdmissionSnapshot().globalInUse).toBe(0);
    const b = await admitAgentRun("y", { waitMs: 0 });
    expect(b.ok).toBe(true);
    if (b.ok) b.release();
  });

  it("waiter acquires after release within budget", async () => {
    configureAdmission({
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerAccount: 1,
      waitMs: 200,
    });
    const held = await admitAgentRun("a");
    expect(held.ok).toBe(true);
    const pending = admitAgentRun("b", { waitMs: 200 });
    await new Promise((r) => setTimeout(r, 20));
    if (held.ok) held.release();
    const got = await pending;
    expect(got.ok).toBe(true);
    if (got.ok) got.release();
  });

  it("atomically reserves one permit for FIFO waiters", async () => {
    configureAdmission({
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerAccount: 1,
      waitMs: 500,
    });
    const held = await admitAgentRun("same");
    expect(held.ok).toBe(true);

    const firstPending = admitAgentRun("same", { waitMs: 500 });
    const secondPending = admitAgentRun("same", { waitMs: 500 });
    let secondSettled = false;
    void secondPending.then(() => {
      secondSettled = true;
    });
    await vi.waitFor(() => {
      expect(getAdmissionSnapshot().waiting).toBe(2);
    });

    if (held.ok) held.release();
    const first = await firstPending;
    expect(first.ok).toBe(true);
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(getAdmissionSnapshot()).toMatchObject({
      globalInUse: 1,
      waiting: 1,
    });

    if (first.ok) first.release();
    const second = await secondPending;
    expect(second.ok).toBe(true);
    if (second.ok) second.release();
    expect(getAdmissionSnapshot()).toEqual({
      globalInUse: 0,
      perAccount: {},
      waiting: 0,
    });
  });

  it("distinguishes cancellation while waiting from capacity denial", async () => {
    configureAdmission({
      maxConcurrentRuns: 1,
      maxConcurrentRunsPerAccount: 1,
      waitMs: 500,
    });
    const held = await admitAgentRun("same");
    expect(held.ok).toBe(true);
    const controller = new AbortController();
    const pending = admitAgentRun("same", {
      signal: controller.signal,
      waitMs: 500,
    });
    await vi.waitFor(() => {
      expect(getAdmissionSnapshot().waiting).toBe(1);
    });

    controller.abort();
    const cancelled = await pending;

    expect(cancelled).toMatchObject({
      ok: false,
      reason: "aborted",
    });
    expect(cancelled).not.toHaveProperty("retryAfterMs");
    expect(getAdmissionSnapshot().waiting).toBe(0);
    if (held.ok) held.release();
  });
});
