import { beforeEach, describe, expect, it, vi } from "vitest";

import { mockFetch } from "../../test/mockFetch";
import {
  ApiError,
  DASHBOARD_KEY_STORAGE,
  api,
  apiRequest,
  errorMessage,
  readDashboardKey,
  writeDashboardKey,
} from "./api";

describe("dashboard key storage", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("round-trips through sessionStorage and clears on empty", () => {
    expect(readDashboardKey()).toBe("");
    writeDashboardKey("secret");
    expect(window.sessionStorage.getItem(DASHBOARD_KEY_STORAGE)).toBe("secret");
    expect(readDashboardKey()).toBe("secret");
    writeDashboardKey("");
    expect(window.sessionStorage.getItem(DASHBOARD_KEY_STORAGE)).toBeNull();
  });
});

describe("apiRequest", () => {
  it("injects the Bearer header only when a key is stored", async () => {
    const fetchMock = mockFetch({ "GET /api/status": { body: { running: true } } });

    await apiRequest("/api/status");
    expect(fetchMock.calls[0].headers.get("authorization")).toBeNull();

    writeDashboardKey("bridge-secret");
    await apiRequest("/api/status");
    expect(fetchMock.calls[1].headers.get("authorization")).toBe(
      "Bearer bridge-secret",
    );
  });

  it("serializes JSON bodies and sets content-type", async () => {
    const fetchMock = mockFetch({ "POST /api/control": { body: { ok: true } } });

    await api.control("restart");

    expect(fetchMock.calls[0].method).toBe("POST");
    expect(fetchMock.calls[0].headers.get("content-type")).toBe("application/json");
    expect(fetchMock.calls[0].body).toEqual({ action: "restart" });
  });

  it("maps 401 to an actionable unauthorized error", async () => {
    mockFetch({
      "GET /api/config": {
        status: 401,
        body: { error: "Authorization Bearer CURSOR_BRIDGE_API_KEY required" },
      },
    });

    const error = await api.config().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(401);
    expect(apiError.kind).toBe("unauthorized");
    expect(apiError.isAuthError).toBe(true);
    expect(apiError.message).toContain("CURSOR_BRIDGE_API_KEY");
    expect(apiError.message).toContain("Settings");
  });

  it("maps 403 to a loopback-aware forbidden error", async () => {
    mockFetch({
      "POST /api/accounts": {
        status: 403,
        body: { error: "Mutating dashboard APIs require CURSOR_BRIDGE_API_KEY" },
      },
    });

    const error = (await api
      .addAccount("work", "crsr_x")
      .catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("forbidden");
    expect(error.isAuthError).toBe(true);
    expect(error.message).toContain("localhost");
  });

  it("normalizes non-JSON error payloads and 5xx", async () => {
    mockFetch({ "GET /api/doctor": { status: 500, text: "boom" } });

    const error = (await api.doctor().catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("server");
    expect(error.message).toBe("boom");
  });

  it("wraps network failures with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );

    const error = (await api.status().catch((e: unknown) => e)) as ApiError;
    expect(error.kind).toBe("network");
    expect(error.status).toBe(0);
    expect(errorMessage(error)).toContain("Failed to fetch");
  });

  it("encodes account names in mutation paths", async () => {
    const fetchMock = mockFetch({
      "DELETE /api/accounts/work%20acct": { body: { ok: true } },
      "PUT /api/accounts/work%20acct/key": { body: { ok: true } },
    });

    await api.removeAccount("work acct");
    await api.setAccountKey("work acct", "crsr_new");

    expect(fetchMock.calls[0].url).toBe("/api/accounts/work%20acct");
    expect(fetchMock.calls[1].url).toBe("/api/accounts/work%20acct/key");
    expect(fetchMock.calls[1].body).toEqual({ apiKey: "crsr_new" });
  });

  it("sends the Bearer header on the plain-text wiki endpoint", async () => {
    writeDashboardKey("bridge-secret");
    const fetchMock = mockFetch({ "GET /api/wiki": { text: "# Wiki\n" } });

    await expect(api.wiki()).resolves.toBe("# Wiki\n");
    expect(fetchMock.calls[0].headers.get("authorization")).toBe(
      "Bearer bridge-secret",
    );
  });
});
