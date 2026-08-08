import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { AuditPage } from "../AuditPage";

const records = [
  {
    ts: "2026-08-08T10:00:00.000Z",
    action: "DELETE /api/accounts/:name",
    method: "DELETE",
    route: "/api/accounts/:name",
    actor: "ops",
    actorFingerprint: "a1b2c3",
    remoteAddress: "127.0.0.1",
    target: "work",
    outcome: "ok",
    status: 200,
  },
  {
    ts: "2026-08-08T09:00:00.000Z",
    action: "POST /api/reset-hwid",
    method: "POST",
    route: "/api/reset-hwid",
    actor: "anonymous",
    remoteAddress: "203.0.113.9",
    outcome: "error",
    status: 403,
    error: "Mutating dashboard APIs require CURSOR_BRIDGE_DASHBOARD_KEY",
  },
];

describe("AuditPage", () => {
  it("lists audited mutations with actor, target and outcome", async () => {
    mockFetch({
      "GET /api/audit": {
        body: { path: "/tmp/audit.jsonl", enabled: true, records },
      },
    });
    renderWithProviders(<AuditPage />);

    expect(
      await screen.findByText("DELETE /api/accounts/:name"),
    ).toBeVisible();
    expect(screen.getByText("POST /api/reset-hwid")).toBeVisible();
    expect(screen.getByText("ops · a1b2c3")).toBeVisible();
    expect(screen.getByText("work")).toBeVisible();
    expect(screen.getByText("203.0.113.9")).toBeVisible();
    expect(screen.getByText("ok 200")).toBeVisible();
    expect(screen.getByText("403")).toBeVisible();
    expect(screen.getByText("1 refused of 2")).toBeVisible();
    expect(screen.getByText("/tmp/audit.jsonl")).toBeVisible();
  });

  it("warns when audit logging is turned off", async () => {
    mockFetch({
      "GET /api/audit": {
        body: { path: "/tmp/audit.jsonl", enabled: false, records: [] },
      },
    });
    renderWithProviders(<AuditPage />);

    expect(
      await screen.findByText("Audit logging is disabled"),
    ).toBeVisible();
    expect(screen.getByText("No audited actions yet")).toBeVisible();
  });

  it("surfaces an auth failure from the gate", async () => {
    mockFetch({
      "GET /api/audit": {
        status: 401,
        body: { error: "Authorization Bearer CURSOR_BRIDGE_DASHBOARD_KEY required" },
      },
    });
    renderWithProviders(<AuditPage />);

    expect(
      await screen.findByText("Could not load the audit log"),
    ).toBeVisible();
    expect(
      screen.getByText(/CURSOR_BRIDGE_DASHBOARD_KEY required/),
    ).toBeVisible();
  });
});
