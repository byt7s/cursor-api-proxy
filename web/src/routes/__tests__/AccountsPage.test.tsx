import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch, type RouteTable } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import type { AccountReport } from "../../lib/types";
import { AccountsPage } from "../AccountsPage";

function account(overrides: Partial<AccountReport> = {}): AccountReport {
  return {
    name: "work",
    configDir: "/Users/me/.cursor-api-proxy/accounts/work",
    authenticated: true,
    authMethod: "cli",
    hasApiKey: true,
    email: "me@example.com",
    displayName: "Me",
    apiKeyName: "laptop",
    apiKeyCreatedAt: null,
    plan: "pro",
    membershipType: "pro",
    subscriptionStatus: "active",
    expiresAt: null,
    usage: { startOfMonth: null, models: [{ id: "gpt-4", numRequests: 12, maxRequestUsage: 500 }] },
    usageError: null,
    ...overrides,
  };
}

const listRoute: RouteTable = {
  "GET /api/accounts": { body: { accounts: [account()] } },
};

describe("AccountsPage", () => {
  it("renders accounts with the dual-credential badge and usage", async () => {
    mockFetch(listRoute);
    renderWithProviders(<AccountsPage />);

    expect(await screen.findByRole("cell", { name: "work" })).toBeVisible();
    expect(screen.getByText("CLI + key")).toBeVisible();
    expect(screen.getByText("me@example.com")).toBeVisible();
    expect(screen.getByText("12 / 500")).toBeVisible();
    expect(
      screen.getByText(/Browser login cannot drive the Cursor CLI TTY flow/),
    ).toBeVisible();
  });

  it("shows the empty state when no accounts exist", async () => {
    mockFetch({ "GET /api/accounts": { body: { accounts: [] } } });
    renderWithProviders(<AccountsPage />);

    expect(await screen.findByText("No accounts found")).toBeVisible();
  });

  it("surfaces a 401 as an actionable error", async () => {
    mockFetch({
      "GET /api/accounts": {
        status: 401,
        body: { error: "Authorization Bearer CURSOR_BRIDGE_API_KEY required" },
      },
    });
    renderWithProviders(<AccountsPage />);

    expect(await screen.findByText("Could not load accounts")).toBeVisible();
    expect(screen.getByText(/Settings/)).toBeVisible();
  });

  it("posts a new API-key account and refreshes the table", async () => {
    const fetchMock = mockFetch({
      ...listRoute,
      "POST /api/accounts": { status: 201, body: { ok: true, name: "second" } },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findByRole("cell", { name: "work" });

    await userEvent.type(
      screen.getAllByLabelText(/Account name/)[0],
      "second",
    );
    await userEvent.type(screen.getAllByLabelText(/API key/)[0], "crsr_new_key");
    await userEvent.click(screen.getByRole("button", { name: "Add account" }));

    await waitFor(() =>
      expect(
        fetchMock.calls.some((call) => call.method === "POST"),
      ).toBe(true),
    );
    const post = fetchMock.calls.find((call) => call.method === "POST");
    expect(post?.url).toBe("/api/accounts");
    expect(post?.body).toEqual({ name: "second", apiKey: "crsr_new_key" });
    expect(await screen.findByText("Added account second")).toBeVisible();
  });

  it("validates the add form before calling the API", async () => {
    const fetchMock = mockFetch(listRoute);
    renderWithProviders(<AccountsPage />);
    await screen.findByRole("cell", { name: "work" });

    await userEvent.click(screen.getByRole("button", { name: "Add account" }));

    expect(await screen.findByText("Check the form")).toBeVisible();
    expect(fetchMock.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("puts a key on an existing account", async () => {
    const fetchMock = mockFetch({
      ...listRoute,
      "PUT /api/accounts/work/key": { body: { ok: true, name: "work" } },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findByRole("cell", { name: "work" });

    await userEvent.type(screen.getAllByLabelText(/Account name/)[1], "work");
    await userEvent.type(screen.getAllByLabelText(/API key/)[1], "crsr_rotated");
    await userEvent.click(screen.getByRole("button", { name: "Set key" }));

    await waitFor(() =>
      expect(fetchMock.calls.some((c) => c.method === "PUT")).toBe(true),
    );
    const put = fetchMock.calls.find((c) => c.method === "PUT");
    expect(put?.url).toBe("/api/accounts/work/key");
    expect(put?.body).toEqual({ apiKey: "crsr_rotated" });
    expect(await screen.findByText("API key saved for work")).toBeVisible();
  });

  it("requires confirmation before deleting an account", async () => {
    const fetchMock = mockFetch({
      ...listRoute,
      "DELETE /api/accounts/work": { body: { ok: true, name: "work" } },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findByRole("cell", { name: "work" });

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(fetchMock.calls.some((c) => c.method === "DELETE")).toBe(false);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Remove account "work"?');

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fetchMock.calls.some((c) => c.method === "DELETE")).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(
      screen.getByRole("dialog").querySelector("button[data-variant='danger']")!,
    );

    await waitFor(() =>
      expect(fetchMock.calls.some((c) => c.method === "DELETE")).toBe(true),
    );
    expect(fetchMock.calls.find((c) => c.method === "DELETE")?.url).toBe(
      "/api/accounts/work",
    );
    expect(await screen.findByText("Removed work")).toBeVisible();
  });

  it("reports a failed removal through a toast", async () => {
    mockFetch({
      ...listRoute,
      "DELETE /api/accounts/work": {
        status: 404,
        body: { error: "Account 'work' not found" },
      },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findByRole("cell", { name: "work" });

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await userEvent.click(
      (await screen.findByRole("dialog")).querySelector(
        "button[data-variant='danger']",
      )!,
    );

    expect(
      await screen.findByText(/Remove failed: Account 'work' not found/),
    ).toBeVisible();
  });

  it("shows unrestricted models badge and saves an allowlist", async () => {
    const fetchMock = mockFetch({
      ...listRoute,
      "GET /api/accounts/work/models": {
        body: {
          name: "work",
          allowedModels: ["composer-2"],
          unrestricted: false,
        },
      },
      "PUT /api/accounts/work/models": {
        body: {
          ok: true,
          name: "work",
          allowedModels: ["composer-2", "sonnet-4.6"],
          unrestricted: false,
        },
      },
    });
    renderWithProviders(<AccountsPage />);
    await screen.findByRole("cell", { name: "work" });
    expect(screen.getByText("all")).toBeVisible();

    const names = screen.getAllByLabelText(/Account name/);
    await userEvent.type(names[names.length - 1]!, "work");
    await userEvent.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() =>
      expect(
        fetchMock.calls.some((c) => c.url === "/api/accounts/work/models"),
      ).toBe(true),
    );

    const textarea = screen.getByPlaceholderText(/composer-2/);
    await userEvent.clear(textarea);
    await userEvent.type(textarea, "composer-2\nsonnet-4.6");
    await userEvent.click(
      screen.getByRole("button", { name: "Save allowlist" }),
    );

    await waitFor(() =>
      expect(
        fetchMock.calls.some(
          (c) => c.method === "PUT" && c.url === "/api/accounts/work/models",
        ),
      ).toBe(true),
    );
    const put = fetchMock.calls.find(
      (c) => c.method === "PUT" && c.url === "/api/accounts/work/models",
    );
    expect(put?.body).toEqual({
      allowedModels: ["composer-2", "sonnet-4.6"],
    });
  });
});
