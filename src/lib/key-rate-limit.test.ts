import { beforeEach, describe, expect, it } from "vitest";

import { consumeKeyRateLimit, resetKeyRateLimits } from "./key-rate-limit.js";

describe("consumeKeyRateLimit", () => {
  beforeEach(() => {
    resetKeyRateLimits();
  });

  it("allows everything when the limit is disabled", () => {
    for (let i = 0; i < 100; i++) {
      expect(consumeKeyRateLimit("k", 0, 1_000).allowed).toBe(true);
    }
  });

  it("allows up to the limit then reports the seconds until the window rolls", () => {
    const start = 1_000_000;
    expect(consumeKeyRateLimit("k", 2, start)).toEqual({
      allowed: true,
      remaining: 1,
    });
    expect(consumeKeyRateLimit("k", 2, start + 10)).toEqual({
      allowed: true,
      remaining: 0,
    });

    const denied = consumeKeyRateLimit("k", 2, start + 20);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBe(60);
  });

  it("reports a shrinking Retry-After as the window drains", () => {
    const start = 2_000_000;
    consumeKeyRateLimit("k", 1, start);
    const denied = consumeKeyRateLimit("k", 1, start + 45_000);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.retryAfterSeconds).toBe(15);
  });

  it("opens a fresh window after 60 seconds", () => {
    const start = 3_000_000;
    consumeKeyRateLimit("k", 1, start);
    expect(consumeKeyRateLimit("k", 1, start + 30_000).allowed).toBe(false);
    expect(consumeKeyRateLimit("k", 1, start + 60_000).allowed).toBe(true);
  });

  it("counts each key separately", () => {
    const start = 4_000_000;
    consumeKeyRateLimit("a", 1, start);
    expect(consumeKeyRateLimit("a", 1, start).allowed).toBe(false);
    expect(consumeKeyRateLimit("b", 1, start).allowed).toBe(true);
  });
});
