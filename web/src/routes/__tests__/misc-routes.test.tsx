import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { ConfigPage } from "../ConfigPage";
import { RequestsPage } from "../RequestsPage";
import { WikiPage } from "../WikiPage";

describe("ConfigPage", () => {
  it("groups the sanitized config into sections", async () => {
    mockFetch({
      "GET /api/config": {
        body: {
          host: "127.0.0.1",
          port: 8765,
          defaultModel: "auto",
          workspace: "/tmp/ws",
          agentBin: "cursor-agent",
          useAcp: true,
          requiredKey: true,
          tlsEnabled: false,
          maxConcurrentRuns: 16,
          maxConcurrentRunsPerAccount: 2,
          sdkMaxConcurrentRuns: 48,
          sdkMaxConcurrentRunsPerAccount: 12,
          admissionWaitMs: 0,
          configDirsCount: 2,
        },
      },
    });
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText("Admission — ACP plane")).toBeVisible();
    expect(screen.getByText("Admission — SDK plane")).toBeVisible();
    expect(screen.getByText("CURSOR_BRIDGE_API_KEY required")).toBeVisible();
    expect(screen.getByText("cursor-agent")).toBeVisible();
  });
});

describe("RequestsPage", () => {
  it("lists requests and re-fetches with a new limit", async () => {
    const fetchMock = mockFetch({
      "GET /api/requests": {
        body: {
          path: "/tmp/sessions.log",
          requests: [
            {
              ts: "2026-08-08T00:00:00.000Z",
              method: "POST",
              pathname: "/v1/chat/completions",
              status: 500,
            },
          ],
        },
      },
    });
    renderWithProviders(<RequestsPage />);

    expect(
      await screen.findByRole("cell", { name: "/v1/chat/completions" }),
    ).toBeVisible();
    expect(screen.getByText("500")).toBeVisible();
    expect(fetchMock.calls[0].url).toBe("/api/requests?limit=40");

    await userEvent.selectOptions(screen.getByLabelText("Request limit"), "200");
    expect(
      await screen.findByRole("cell", { name: "/v1/chat/completions" }),
    ).toBeVisible();
    expect(
      fetchMock.calls.some((c) => c.url === "/api/requests?limit=200"),
    ).toBe(true);
  });
});

describe("WikiPage", () => {
  it("renders the markdown returned by /api/wiki", async () => {
    mockFetch({
      "GET /api/wiki": {
        text: "# cursor-api-proxy\n\nOpen the [dashboard](/) to start.\n",
      },
    });
    renderWithProviders(<WikiPage />);

    expect(
      await screen.findByRole("heading", { name: "cursor-api-proxy", level: 1 }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "dashboard" })).toHaveAttribute(
      "href",
      "/",
    );
  });
});
