/**
 * Per-key request throttling (`CURSOR_BRIDGE_KEY_RATE_LIMIT_PER_MIN`).
 *
 * A fixed 60-second window per key is enough for the "one noisy client must
 * not drain the account pool" case this exists for, and it needs no timers:
 * each key keeps a counter plus the timestamp its window opened, and callers
 * get back the seconds until that window rolls over for `Retry-After`.
 */

const WINDOW_MS = 60_000;

type Window = { count: number; startedAt: number };

const windows = new Map<string, Window>();

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSeconds: number };

/**
 * Counts one request against `key`. `limitPerMin <= 0` disables the check and
 * always allows, so the hot path stays a single comparison when unused.
 */
export function consumeKeyRateLimit(
  key: string,
  limitPerMin: number,
  now: number = Date.now(),
): RateLimitDecision {
  if (limitPerMin <= 0) return { allowed: true, remaining: Infinity };

  const current = windows.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    windows.set(key, { count: 1, startedAt: now });
    return { allowed: true, remaining: limitPerMin - 1 };
  }

  if (current.count >= limitPerMin) {
    const elapsed = now - current.startedAt;
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((WINDOW_MS - elapsed) / 1000)),
    };
  }

  current.count += 1;
  return { allowed: true, remaining: limitPerMin - current.count };
}

/** Test hook — the counters are process-global by design. */
export function resetKeyRateLimits(): void {
  windows.clear();
}
