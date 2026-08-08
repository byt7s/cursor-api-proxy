import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import type { RequestRecord } from "../../lib/types";
import { RequestsPage } from "../RequestsPage";

const record: RequestRecord = {
  ts: "2026-08-08T00:00:00.000Z",
  method: "POST",
  pathname: "/v1/chat/completions",
  remoteAddress: "127.0.0.1",
  status: 503,
  durationMs: 1234,
  model: "claude-4.5-sonnet",
  engine: "acp",
  account: "work",
  streaming: true,
  errorCode: "agent_capacity",
  failoverCount: 2,
  spans: { account_select: 4, model_first_byte: 820, total: 1234 },
  hasConversation: true,
  conversationHash: "9d0f1a2b3c4d",
  promptChars: 480,
  completionChars: 1200,
};

function mockRequests(payload: unknown) {
  return mockFetch({ "GET /api/requests": { body: payload } });
}

describe("RequestsPage", () => {
  it("lists requests and re-fetches with a new limit", async () => {
    const fetchMock = mockRequests({
      path: "/tmp/sessions.log",
      source: "text",
      requests: [
        {
          ts: "2026-08-08T00:00:00.000Z",
          method: "POST",
          pathname: "/v1/chat/completions",
          status: 500,
        },
      ],
    });
    renderWithProviders(<RequestsPage />);

    expect(
      await screen.findByRole("cell", { name: "/v1/chat/completions" }),
    ).toBeVisible();
    expect(screen.getByText("500")).toBeVisible();
    expect(screen.getByText("text log")).toBeVisible();
    expect(fetchMock.calls[0].url).toBe("/api/requests?limit=40");

    await userEvent.selectOptions(screen.getByLabelText("Request limit"), "200");
    expect(
      await screen.findByRole("cell", { name: "/v1/chat/completions" }),
    ).toBeVisible();
    expect(
      fetchMock.calls.some((c) => c.url === "/api/requests?limit=200"),
    ).toBe(true);
  });

  it("shows model and duration columns for structured records", async () => {
    mockRequests({
      path: "/tmp/requests.jsonl",
      source: "jsonl",
      requests: [record],
    });
    renderWithProviders(<RequestsPage />);

    expect(
      await screen.findByRole("cell", { name: "claude-4.5-sonnet" }),
    ).toBeVisible();
    expect(screen.getByRole("cell", { name: "1.23 s" })).toBeVisible();
    expect(screen.getByText("structured log")).toBeVisible();
  });

  it("opens the detail modal with spans, error code and raw record", async () => {
    mockRequests({
      path: "/tmp/requests.jsonl",
      source: "jsonl",
      requests: [record],
    });
    renderWithProviders(<RequestsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Details" }));

    const dialog = screen.getByRole("dialog", { name: "Request detail" });
    expect(dialog).toHaveAccessibleDescription("POST /v1/chat/completions");
    expect(within(dialog).getByText("agent_capacity")).toBeVisible();
    expect(within(dialog).getByText("claude-4.5-sonnet")).toBeVisible();
    expect(within(dialog).getByText("acp")).toBeVisible();
    expect(within(dialog).getByText("work")).toBeVisible();
    expect(within(dialog).getByText("stream")).toBeVisible();
    expect(within(dialog).getByText("9d0f1a2b3c4d")).toBeVisible();
    expect(within(dialog).getByText("480 / 1200")).toBeVisible();

    // Latency waterfall: one labelled row per recorded span.
    expect(within(dialog).getByText("Account select")).toBeVisible();
    expect(within(dialog).getByText("Model first byte")).toBeVisible();
    expect(within(dialog).getByText("820 ms")).toBeVisible();
    expect(within(dialog).queryByText("Session ready")).toBeNull();

    expect(within(dialog).getByText(/"errorCode": "agent_capacity"/)).toBeVisible();

    await userEvent.click(within(dialog).getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens the detail modal from a row click", async () => {
    mockRequests({
      path: "/tmp/requests.jsonl",
      source: "jsonl",
      requests: [record],
    });
    renderWithProviders(<RequestsPage />);

    await userEvent.click(
      await screen.findByRole("cell", { name: "/v1/chat/completions" }),
    );
    expect(screen.getByRole("dialog", { name: "Request detail" })).toBeVisible();
  });

  it("explains a missing waterfall for text-log rows", async () => {
    mockRequests({
      path: "/tmp/sessions.log",
      source: "text",
      requests: [
        {
          ts: "2026-08-08T00:00:00.000Z",
          method: "GET",
          pathname: "/healthz",
          status: 200,
        },
      ],
    });
    renderWithProviders(<RequestsPage />);

    await userEvent.click(await screen.findByRole("button", { name: "Details" }));
    const dialog = screen.getByRole("dialog", { name: "Request detail" });
    expect(within(dialog).getByText(/No latency spans recorded/)).toBeVisible();
  });
});
