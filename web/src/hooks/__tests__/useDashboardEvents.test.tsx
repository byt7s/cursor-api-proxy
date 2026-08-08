import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  DashboardEventsProvider,
  useDashboardEvents,
} from "../useDashboardEvents";

function Probe({ label }: { label: string }) {
  const mode = useDashboardEvents({ onStatus: () => undefined });
  return <span data-testid="mode">{label}:{mode}</span>;
}

describe("useDashboardEvents", () => {
  it("falls back to polling when fetch rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline")),
    );
    render(
      <DashboardEventsProvider>
        <Probe label="m" />
      </DashboardEventsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mode")).toHaveTextContent("m:polling"),
    );
    vi.unstubAllGlobals();
  });

  it("reports sse when the stream opens", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode("event: status\ndata: {}\n\n"),
        );
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: stream,
        headers: new Headers({ "content-type": "text/event-stream" }),
      }),
    );
    render(
      <DashboardEventsProvider>
        <Probe label="m" />
      </DashboardEventsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mode")).toHaveTextContent("m:sse"),
    );
    vi.unstubAllGlobals();
  });
});
