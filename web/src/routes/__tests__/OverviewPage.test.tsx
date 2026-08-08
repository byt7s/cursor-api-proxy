import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch, type RouteTable } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { OverviewPage } from "../OverviewPage";

const routes: RouteTable = {
  "GET /api/status": {
    body: {
      running: true,
      pid: 4242,
      port: 8765,
      host: "127.0.0.1",
      version: "1.3.0",
      uptimeSeconds: 3725,
      launchdLoaded: true,
      plistPath: "/Users/me/Library/LaunchAgents/com.cursor-api-proxy.plist",
      packageRoot: "/opt/cursor-api-proxy",
      publicDir: "/opt/cursor-api-proxy/public",
      docsDir: "/opt/cursor-api-proxy/docs",
      storageDir: "/Users/me/.cursor-api-proxy",
      sessionsLogPath: "/Users/me/.cursor-api-proxy/sessions.log",
      serviceLog: "/Users/me/.cursor-api-proxy/proxy.log",
      pidFile: "/Users/me/.cursor-api-proxy/proxy.pid",
      apiKeyConfigured: true,
      bridgeApiKeyRequired: false,
      node: "v22.0.0",
      platform: "darwin arm64",
      startedAt: "2026-08-08T00:00:00.000Z",
    },
  },
  "GET /api/stats": {
    body: { windowHours: 1, total: 10, errors: 1, byPath: {}, recent: [] },
  },
  "GET /api/config": {
    body: {
      useAcp: true,
      maxConcurrentRuns: 16,
      maxConcurrentRunsPerAccount: 2,
      sdkMaxConcurrentRuns: 48,
      sdkMaxConcurrentRunsPerAccount: 12,
    },
  },
  "GET /api/accounts": { body: { accounts: [{ name: "work", hasApiKey: true }] } },
};

describe("OverviewPage", () => {
  it("renders status, stats and admission caps", async () => {
    mockFetch(routes);
    renderWithProviders(<OverviewPage />, { withStatus: true });

    expect(await screen.findByText(/^1h 2m \(since /)).toBeVisible();
    expect(screen.getByText("running")).toBeVisible();
    expect(screen.getByText("http://127.0.0.1:8765")).toBeVisible();
    expect(await screen.findByText("90%")).toBeVisible();
    expect(
      await screen.findByText("ACP 16/2 · SDK 48/12"),
    ).toBeVisible();
  });

  it("confirms before stopping the proxy and posts the control action", async () => {
    const fetchMock = mockFetch({
      ...routes,
      "POST /api/control": {
        body: { ok: true, action: "stop", scheduled: true },
      },
    });
    renderWithProviders(<OverviewPage />, { withStatus: true });
    await screen.findByText("running");

    await userEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(false);

    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Stop the proxy?",
    );
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() =>
      expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(true),
    );
    expect(fetchMock.calls.find((c) => c.method === "POST")?.body).toEqual({
      action: "stop",
    });
    expect(
      await screen.findByText("Scheduled: cursor-api-proxy stop"),
    ).toBeVisible();
  });

  it("runs unconfirmed actions immediately", async () => {
    const fetchMock = mockFetch({
      ...routes,
      "POST /api/control": {
        body: { ok: true, action: "enable", scheduled: true },
      },
    });
    renderWithProviders(<OverviewPage />, { withStatus: true });
    await screen.findByText("running");

    await userEvent.click(
      screen.getByRole("button", { name: "Enable autostart" }),
    );

    await waitFor(() =>
      expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(true),
    );
    expect(fetchMock.calls.find((c) => c.method === "POST")?.body).toEqual({
      action: "enable",
    });
  });
});
