import { describe, expect, it } from "vitest";
import {
  isCursorAuthErrorPayload,
  isSessionAccessToken,
  parseApiKeyProfileResponse,
  parseUsageApiResponse,
} from "./usage.js";

describe("isSessionAccessToken", () => {
  it("rejects agent API keys", () => {
    expect(isSessionAccessToken("crsr_abc123")).toBe(false);
  });

  it("accepts JWT-shaped tokens", () => {
    expect(isSessionAccessToken("aaa.bbb.ccc")).toBe(true);
  });
});

describe("parseUsageApiResponse", () => {
  it("returns null for unauthenticated Cursor payloads", () => {
    expect(
      parseUsageApiResponse({
        code: "unauthenticated",
        message: "[unauthenticated] Error",
        details: [{ type: "aiserver.v1.ErrorDetails" }],
      }),
    ).toBeNull();
    expect(
      isCursorAuthErrorPayload({
        code: "unauthenticated",
        message: "[unauthenticated] Error",
      }),
    ).toBe(true);
  });

  it("parses real usage model rows", () => {
    const parsed = parseUsageApiResponse({
      startOfMonth: "2026-08-01T00:00:00.000Z",
      "gpt-4": {
        numRequests: 12,
        numRequestsTotal: 12,
        numTokens: 100,
        maxTokenUsage: null,
        maxRequestUsage: 500,
      },
    });
    expect(parsed).toEqual({
      startOfMonth: "2026-08-01T00:00:00.000Z",
      models: {
        "gpt-4": {
          numRequests: 12,
          numRequestsTotal: 12,
          numTokens: 100,
          maxTokenUsage: null,
          maxRequestUsage: 500,
        },
      },
    });
  });
});

describe("parseApiKeyProfileResponse", () => {
  it("parses /v1/me identity fields", () => {
    expect(
      parseApiKeyProfileResponse({
        apiKeyName: "cursor-api-proxy",
        createdAt: "2026-08-08T05:05:01.564Z",
        userEmail: "byt7s@pm.me",
      }),
    ).toEqual({
      apiKeyName: "cursor-api-proxy",
      createdAt: "2026-08-08T05:05:01.564Z",
      userEmail: "byt7s@pm.me",
    });
  });
});
