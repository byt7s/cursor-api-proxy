import type * as http from "node:http";
import { describe, expect, it, vi } from "vitest";

import { applyCors, corsHeadersFor, parseCorsOrigins } from "./cors.js";

function fakeResponse() {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
  return { res: res as unknown as http.ServerResponse, headers, spy: res };
}

function fakeRequest(
  method: string,
  origin?: string,
): http.IncomingMessage {
  return {
    method,
    headers: origin ? { origin } : {},
  } as unknown as http.IncomingMessage;
}

describe("parseCorsOrigins", () => {
  it("splits, trims and drops trailing slashes", () => {
    expect(
      parseCorsOrigins(" http://localhost:5173/ , https://app.example.com "),
    ).toEqual(["http://localhost:5173", "https://app.example.com"]);
  });

  it("is empty when unset", () => {
    expect(parseCorsOrigins(undefined)).toEqual([]);
    expect(parseCorsOrigins("")).toEqual([]);
  });
});

describe("corsHeadersFor", () => {
  it("echoes an allowed origin with the header and method allowances", () => {
    const headers = corsHeadersFor("http://localhost:5173", [
      "http://localhost:5173",
    ]);
    expect(headers).toMatchObject({
      "access-control-allow-origin": "http://localhost:5173",
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      vary: "Origin",
    });
    expect(headers?.["access-control-allow-headers"]).toContain("authorization");
  });

  it("answers wildcard configuration with *", () => {
    expect(
      corsHeadersFor("https://anything.example", ["*"]),
    ).toMatchObject({ "access-control-allow-origin": "*" });
  });

  it("returns null for unlisted origins and when CORS is off", () => {
    expect(corsHeadersFor("https://evil.example", ["http://ok"])).toBeNull();
    expect(corsHeadersFor("http://ok", [])).toBeNull();
    expect(corsHeadersFor(undefined, ["http://ok"])).toBeNull();
  });

  it("never allows credentials", () => {
    const headers = corsHeadersFor("http://ok", ["http://ok"]);
    expect(headers).not.toHaveProperty("access-control-allow-credentials");
  });
});

describe("applyCors", () => {
  it("sets headers on a normal request without answering it", () => {
    const { res, headers } = fakeResponse();
    const result = applyCors(fakeRequest("POST", "http://ok"), res, [
      "http://ok",
    ]);
    expect(result.preflightHandled).toBe(false);
    expect(headers["access-control-allow-origin"]).toBe("http://ok");
  });

  it("answers an allowed preflight with 204", () => {
    const { res, spy } = fakeResponse();
    const result = applyCors(fakeRequest("OPTIONS", "http://ok"), res, [
      "http://ok",
    ]);
    expect(result.preflightHandled).toBe(true);
    expect(spy.writeHead).toHaveBeenCalledWith(204, { "content-length": 0 });
  });

  it("answers a disallowed preflight with 403 and no allow header", () => {
    const { res, spy, headers } = fakeResponse();
    const result = applyCors(fakeRequest("OPTIONS", "http://evil"), res, [
      "http://ok",
    ]);
    expect(result.preflightHandled).toBe(true);
    expect(spy.writeHead).toHaveBeenCalledWith(403, { "content-length": 0 });
    expect(headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("adds nothing when no origins are configured", () => {
    const { res, headers, spy } = fakeResponse();
    applyCors(fakeRequest("GET", "http://ok"), res, []);
    expect(headers).toEqual({});
    expect(spy.writeHead).not.toHaveBeenCalled();
  });
});
