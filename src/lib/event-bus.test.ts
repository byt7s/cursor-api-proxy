import { afterEach, describe, expect, it, vi } from "vitest";

import {
  dashboardEventSubscriberCount,
  publishDashboardEvent,
  resetDashboardEventBus,
  subscribeDashboardEvents,
} from "./event-bus.js";

afterEach(() => {
  resetDashboardEventBus();
});

describe("event-bus", () => {
  it("delivers published events to every subscriber", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeDashboardEvents(a);
    subscribeDashboardEvents(b);
    publishDashboardEvent({ type: "status", data: { ok: true } });
    expect(a).toHaveBeenCalledWith({ type: "status", data: { ok: true } });
    expect(b).toHaveBeenCalledWith({ type: "status", data: { ok: true } });
  });

  it("unsubscribes cleanly and ignores listener errors", () => {
    const good = vi.fn();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const unsub = subscribeDashboardEvents(bad);
    subscribeDashboardEvents(good);
    expect(dashboardEventSubscriberCount()).toBe(2);
    publishDashboardEvent({ type: "log", data: { line: "x" } });
    expect(good).toHaveBeenCalledTimes(1);
    unsub();
    expect(dashboardEventSubscriberCount()).toBe(1);
    publishDashboardEvent({ type: "accounts" });
    expect(good).toHaveBeenCalledTimes(2);
    expect(bad).toHaveBeenCalledTimes(1);
  });
});
