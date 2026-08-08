import { vi } from "vitest";

export type RouteHandler = {
  status?: number;
  body?: unknown;
  /** Returned verbatim for non-JSON endpoints such as `/api/wiki`. */
  text?: string;
};

export type RouteTable = Record<string, RouteHandler>;

export type MockFetch = ReturnType<typeof vi.fn> & {
  calls: Array<{ url: string; method: string; body: unknown; headers: Headers }>;
};

/**
 * Installs a deterministic `fetch` that answers from a `"METHOD /path"` table.
 * Unmatched requests resolve as 404 so tests fail loudly instead of hanging.
 */
export function mockFetch(routes: RouteTable): MockFetch {
  const calls: MockFetch["calls"] = [];

  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = init?.body;
    calls.push({
      url,
      method,
      body: typeof rawBody === "string" ? JSON.parse(rawBody) : rawBody,
      headers,
    });

    const path = url.split("?")[0] ?? url;
    const handler =
      routes[`${method} ${url}`] ??
      routes[`${method} ${path}`] ??
      routes[url] ??
      routes[path];

    if (!handler) {
      return new Response(JSON.stringify({ error: `no mock for ${method} ${url}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    if (handler.text !== undefined) {
      return new Response(handler.text, { status: handler.status ?? 200 });
    }

    return new Response(JSON.stringify(handler.body ?? {}), {
      status: handler.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as MockFetch;

  fn.calls = calls;
  vi.stubGlobal("fetch", fn);
  return fn;
}
