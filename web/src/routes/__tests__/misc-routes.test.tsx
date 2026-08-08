import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { mockFetch } from "../../../test/mockFetch";
import { renderWithProviders } from "../../../test/renderWithProviders";
import { WikiPage } from "../WikiPage";

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
