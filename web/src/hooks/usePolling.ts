import { useEffect, useRef } from "react";

/**
 * Calls `callback` every `intervalMs` while `enabled`. The latest callback is
 * always used, so changing handlers does not restart the timer.
 */
export function usePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  enabled = true,
): void {
  const saved = useRef(callback);
  saved.current = callback;

  useEffect(() => {
    if (!enabled || intervalMs <= 0) return;
    const timer = setInterval(() => {
      void saved.current();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
}
