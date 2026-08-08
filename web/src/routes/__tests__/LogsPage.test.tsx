import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { LogsPage } from "../LogsPage";

const logRoute = {
  "GET /api/log": {
    body: {
      path: "/Users/me/.cursor-api-proxy/sessions.log",
      lines: ["2026-08-08T00:00:00.000Z POST /v1/chat/completions 127.0.0.1 200"],
    },
  },
};

describe("LogsPage", () => {
  it("renders the tail and its source path", async () => {
    mockFetch(logRoute);
    renderWithProviders(<LogsPage />);

    expect(
      await screen.findByText(/POST \/v1\/chat\/completions/),
    ).toBeVisible();
    expect(
      screen.getByText("/Users/me/.cursor-api-proxy/sessions.log"),
    ).toBeVisible();
  });

  it("toggles the pause control", async () => {
    mockFetch(logRoute);
    renderWithProviders(<LogsPage />);
    await screen.findByText(/POST \/v1\/chat\/completions/);

    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Resume" })).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(screen.getByRole("button", { name: "Pause" })).toBeVisible();
  });

  it("re-requests the tail when the line count changes", async () => {
    const fetchMock = mockFetch(logRoute);
    renderWithProviders(<LogsPage />);
    await screen.findByText(/POST \/v1\/chat\/completions/);

    expect(fetchMock.calls[0].url).toBe("/api/log?lines=200");

    await userEvent.selectOptions(screen.getByLabelText("Tail size"), "500");
    await waitFor(() =>
      expect(
        fetchMock.calls.some((c) => c.url === "/api/log?lines=500"),
      ).toBe(true),
    );
  });

  it("confirms before clearing and reports the archive path", async () => {
    const fetchMock = mockFetch({
      ...logRoute,
      "POST /api/log/clear": { body: { archivePath: "/tmp/sessions.log.archive" } },
    });
    renderWithProviders(<LogsPage />);
    await screen.findByText(/POST \/v1\/chat\/completions/);

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(false);
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Clear and archive the current sessions log?",
    );

    await userEvent.click(screen.getByRole("button", { name: "Clear log" }));
    await waitFor(() =>
      expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(true),
    );
    expect(
      await screen.findByText("Archived log to /tmp/sessions.log.archive"),
    ).toBeVisible();
  });

  it("shows a normalized error when the log cannot be read", async () => {
    mockFetch({ "GET /api/log": { status: 500, body: { error: "EACCES" } } });
    renderWithProviders(<LogsPage />);

    expect(await screen.findByText("Could not read log")).toBeVisible();
    expect(screen.getByText("EACCES")).toBeVisible();
  });
});
