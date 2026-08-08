import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { THEME_STORAGE_KEY } from "../../hooks";
import { DASHBOARD_KEY_STORAGE } from "../../lib/api";
import { SETTINGS_STORAGE_KEY } from "../../hooks/useSettings";
import { SettingsPage } from "../SettingsPage";

describe("SettingsPage", () => {
  it("persists the dashboard key in sessionStorage and clears it again", async () => {
    mockFetch({});
    renderWithProviders(<SettingsPage />);

    expect(screen.getByText(/No key stored/)).toBeVisible();

    await userEvent.type(
      screen.getByLabelText(/CURSOR_BRIDGE_DASHBOARD_KEY/),
      "bridge-secret",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save in session" }));

    expect(window.sessionStorage.getItem(DASHBOARD_KEY_STORAGE)).toBe(
      "bridge-secret",
    );
    expect(
      await screen.findByText("Dashboard key saved for this tab session"),
    ).toBeVisible();
    expect(screen.getByText(/A key is stored in sessionStorage/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(window.sessionStorage.getItem(DASHBOARD_KEY_STORAGE)).toBeNull();
    expect(screen.getByLabelText(/CURSOR_BRIDGE_DASHBOARD_KEY/)).toHaveValue("");
  });

  it("switches theme and stores the choice", async () => {
    mockFetch({});
    renderWithProviders(<SettingsPage />);

    expect(document.documentElement).toHaveAttribute("data-theme", "dark");

    await userEvent.click(screen.getByRole("switch", { name: "Dark theme" }));

    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("persists poll interval changes", async () => {
    mockFetch({});
    renderWithProviders(<SettingsPage />);

    await userEvent.selectOptions(screen.getByLabelText("Status"), "30000");

    const stored = JSON.parse(
      window.localStorage.getItem(SETTINGS_STORAGE_KEY) ?? "{}",
    ) as { statusMs?: number };
    expect(stored.statusMs).toBe(30_000);
  });
});
