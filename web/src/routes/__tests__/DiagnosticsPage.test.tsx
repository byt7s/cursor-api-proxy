import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { DiagnosticsPage } from "../DiagnosticsPage";

const doctorRoute = {
  "GET /api/doctor": {
    body: {
      ok: false,
      checks: [
        { name: "accounts", ok: true, detail: "2 account(s) configured" },
        { name: "default model", ok: false, detail: "model not in list" },
      ],
    },
  },
};

describe("DiagnosticsPage", () => {
  it("renders doctor checks with pass/fail badges", async () => {
    mockFetch(doctorRoute);
    renderWithProviders(<DiagnosticsPage />);

    expect(await screen.findByRole("cell", { name: "accounts" })).toBeVisible();
    expect(screen.getByText("pass")).toBeVisible();
    expect(screen.getByText("fail")).toBeVisible();
    expect(screen.getByText("1 check failing")).toBeVisible();
  });

  it("shows the doctor error when the request is refused", async () => {
    mockFetch({
      "GET /api/doctor": { status: 401, body: { error: "Bearer required" } },
    });
    renderWithProviders(<DiagnosticsPage />);

    expect(await screen.findByText("Doctor failed")).toBeVisible();
  });

  it("requires two confirmations before resetting the HWID", async () => {
    const fetchMock = mockFetch({
      ...doctorRoute,
      "POST /api/reset-hwid": { body: { ok: true, deepClean: true } },
    });
    renderWithProviders(<DiagnosticsPage />);
    await screen.findByRole("cell", { name: "accounts" });

    await userEvent.click(screen.getByLabelText(/Deep clean/));
    await userEvent.click(screen.getByRole("button", { name: "Reset HWID" }));

    expect(await screen.findByText("Reset Cursor HWID")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(false);

    expect(await screen.findByText("Final confirmation")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Reset now" }));

    await waitFor(() =>
      expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(true),
    );
    const post = fetchMock.calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("/api/reset-hwid");
    expect(post?.body).toEqual({ deepClean: true });
    expect(await screen.findByText("HWID reset complete")).toBeVisible();
  });

  it("cancels the reset without calling the API", async () => {
    const fetchMock = mockFetch(doctorRoute);
    renderWithProviders(<DiagnosticsPage />);
    await screen.findByRole("cell", { name: "accounts" });

    await userEvent.click(screen.getByRole("button", { name: "Reset HWID" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchMock.calls.every((c) => c.method === "GET")).toBe(true);
  });
});
