import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DASHBOARD_KEY_STORAGE, writeDashboardKey } from "../../lib/api";
import {
  DashboardEventsProvider,
  useDashboardEvents,
} from "../useDashboardEvents";

function Probe({ label }: { label: string }) {
  const mode = useDashboardEvents({ onStatus: () => undefined });
  return <span data-testid="mode">{label}:{mode}</span>;
}

function FanOutProbe({
  onStatus,
  onRequest,
  onLog,
}: {
  onStatus: () => void;
  onRequest: () => void;
  onLog: (line: string) => void;
}) {
  const mode = useDashboardEvents({ onStatus, onRequest, onLog });
  return <span data-testid="mode">fan:{mode}</span>;
}

describe("useDashboardEvents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.sessionStorage.removeItem(DASHBOARD_KEY_STORAGE);
  });

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
  });

  it("sends Authorization Bearer from the stored dashboard key", async () => {
    writeDashboardKey("dash-from-storage");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode("event: status\ndata: {}\n\n"),
          );
        },
      }),
      headers: new Headers({ "content-type": "text/event-stream" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <DashboardEventsProvider>
        <Probe label="m" />
      </DashboardEventsProvider>,
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/events");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: {
        Accept: "text/event-stream",
        Authorization: "Bearer dash-from-storage",
      },
    });
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
  });

  it("falls back to polling when the response is not ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        body: null,
        headers: new Headers(),
      }),
    );
    render(
      <DashboardEventsProvider>
        <Probe label="m" />
      </DashboardEventsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("mode")).toHaveTextContent("m:polling"),
    );
  });

  it("falls back to polling when the stream ends mid-flight", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
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
    streamController.close();
    await waitFor(() =>
      expect(screen.getByTestId("mode")).toHaveTextContent("m:polling"),
    );
  });

  it("fans out status, request, and log events to handlers", async () => {
    const onStatus = vi.fn();
    const onRequest = vi.fn();
    const onLog = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode("event: status\ndata: {}\n\n"));
        controller.enqueue(
          enc.encode('event: request\ndata: {"id":"r1"}\n\n'),
        );
        controller.enqueue(
          enc.encode('event: log\ndata: {"line":"hello-bus"}\n\n'),
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
        <FanOutProbe
          onStatus={onStatus}
          onRequest={onRequest}
          onLog={onLog}
        />
      </DashboardEventsProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("mode")).toHaveTextContent("fan:sse"),
    );
    await waitFor(() => {
      expect(onStatus).toHaveBeenCalled();
      expect(onRequest).toHaveBeenCalled();
      expect(onLog).toHaveBeenCalledWith("hello-bus");
    });
  });
});
