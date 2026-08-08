import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { readDashboardKey } from "../lib/api";

export type DashboardSseHandlers = {
  onStatus?: () => void;
  onStats?: () => void;
  onRequest?: () => void;
  onLog?: (line: string) => void;
  onAccounts?: () => void;
};

export type DashboardEventsMode = "sse" | "polling" | "connecting";

type DashboardEventsContextValue = {
  mode: DashboardEventsMode;
  subscribe: (handlers: DashboardSseHandlers) => () => void;
};

const DashboardEventsContext =
  createContext<DashboardEventsContextValue | null>(null);

/**
 * One shared `GET /api/events` stream for the whole dashboard. Pages subscribe
 * for the event types they care about; when the stream fails, `mode` becomes
 * `polling` so existing interval hooks keep working.
 */
export function DashboardEventsProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<DashboardEventsMode>("connecting");
  const listenersRef = useRef(new Set<DashboardSseHandlers>());

  useEffect(() => {
    if (typeof fetch !== "function" || typeof ReadableStream === "undefined") {
      setMode("polling");
      return;
    }

    let cancelled = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const controller = new AbortController();

    const fanOut = (name: string, data: Record<string, unknown>) => {
      for (const h of listenersRef.current) {
        if (name === "status") h.onStatus?.();
        else if (name === "stats") h.onStats?.();
        else if (name === "request") h.onRequest?.();
        else if (name === "accounts") h.onAccounts?.();
        else if (name === "log") {
          const line = typeof data.line === "string" ? data.line : "";
          if (line) h.onLog?.(line);
        }
      }
    };

    async function connect(): Promise<void> {
      const headers: Record<string, string> = {
        Accept: "text/event-stream",
      };
      const key = readDashboardKey();
      if (key) headers.Authorization = `Bearer ${key}`;

      let response: Response;
      try {
        response = await fetch("/api/events", {
          headers,
          signal: controller.signal,
        });
      } catch {
        if (!cancelled) setMode("polling");
        return;
      }

      if (!response.ok || !response.body) {
        if (!cancelled) setMode("polling");
        return;
      }

      if (!cancelled) setMode("sse");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let eventName = "message";
      let dataLines: string[] = [];

      const dispatch = () => {
        const raw = dataLines.join("\n");
        dataLines = [];
        const name = eventName;
        eventName = "message";
        let data: Record<string, unknown> = {};
        if (raw) {
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { raw };
          }
        }
        fanOut(name, data);
      };

      try {
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split(/\r?\n/);
          buffer = parts.pop() ?? "";
          for (const line of parts) {
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
              continue;
            }
            if (line === "" && dataLines.length) dispatch();
          }
        }
      } catch {
        /* aborted */
      }

      if (!cancelled) setMode("polling");
    }

    void connect();
    return () => {
      cancelled = true;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    };
  }, []);

  const value: DashboardEventsContextValue = {
    mode,
    subscribe: (handlers) => {
      listenersRef.current.add(handlers);
      return () => {
        listenersRef.current.delete(handlers);
      };
    },
  };

  return (
    <DashboardEventsContext.Provider value={value}>
      {children}
    </DashboardEventsContext.Provider>
  );
}

/**
 * Subscribe to dashboard SSE events. Returns `sse` | `polling` | `connecting`
 * so callers can disable their interval pollers when the stream is live.
 */
export function useDashboardEvents(
  handlers: DashboardSseHandlers,
  enabled = true,
): DashboardEventsMode {
  const ctx = useContext(DashboardEventsContext);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled || !ctx) return;
    const proxy: DashboardSseHandlers = {
      onStatus: () => handlersRef.current.onStatus?.(),
      onStats: () => handlersRef.current.onStats?.(),
      onRequest: () => handlersRef.current.onRequest?.(),
      onLog: (line) => handlersRef.current.onLog?.(line),
      onAccounts: () => handlersRef.current.onAccounts?.(),
    };
    return ctx.subscribe(proxy);
  }, [ctx, enabled]);

  if (!ctx || !enabled) return "polling";
  return ctx.mode;
}
