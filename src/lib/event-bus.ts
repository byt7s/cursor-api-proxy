/**
 * Tiny process-local pub/sub for dashboard SSE.
 *
 * Publishers (request finish, log writers, account mutations) emit here;
 * `GET /api/events` subscribers forward framed events to browsers. Emit is
 * synchronous and never awaits — request paths must stay non-blocking.
 */

export type DashboardEventType = "status" | "stats" | "request" | "log" | "accounts";

export type DashboardEvent = {
  type: DashboardEventType;
  /** Optional payload (e.g. a new log line). */
  data?: Record<string, unknown>;
};

type Listener = (event: DashboardEvent) => void;

const listeners = new Set<Listener>();

/** Notify every subscriber. Listener errors are swallowed so one bad client cannot break others. */
export function publishDashboardEvent(event: DashboardEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      /* ignore */
    }
  }
}

/** Subscribe; returns an unsubscribe function. */
export function subscribeDashboardEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test helper — drops every subscriber. */
export function resetDashboardEventBus(): void {
  listeners.clear();
}

export function dashboardEventSubscriberCount(): number {
  return listeners.size;
}
