import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { ConfigPage } from "../ConfigPage";
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
          requestsLogPath: "/tmp/requests.jsonl",
          requestsLogEnabled: true,
          requestsLogMaxBytes: 33_554_432,
          metricsEnabled: true,
        },
      },
    });
    renderWithProviders(<ConfigPage />);

    expect(await screen.findByText("Admission — ACP plane")).toBeVisible();
    expect(screen.getByText("Admission — SDK plane")).toBeVisible();
    expect(screen.getByText("CURSOR_BRIDGE_API_KEY required")).toBeVisible();
    expect(screen.getByText("cursor-agent")).toBeVisible();
    expect(screen.getByText("Observability")).toBeVisible();
    expect(screen.getByText("/tmp/requests.jsonl")).toBeVisible();
    expect(screen.getByText("32 MB")).toBeVisible();
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
