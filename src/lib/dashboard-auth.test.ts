import type * as http from "node:http";
import { describe, expect, it } from "vitest";

import type { ApiKeyEntry } from "./api-keys.js";
import {
  authorizeSensitiveApi,
  dashboardIsKeyProtected,
  type SensitiveAuthConfig,
} from "./dashboard-auth.js";

const CHAT_KEY: ApiKeyEntry = { label: "ci", scope: "chat", key: "sk-ci" };
const ADMIN_KEY: ApiKeyEntry = { label: "ops", scope: "admin", key: "sk-ops" };

function request(
  token?: string,
  remoteAddress = "127.0.0.1",
): http.IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    socket: { remoteAddress },
  } as unknown as http.IncomingMessage;
}

function config(
  overrides: Partial<SensitiveAuthConfig> = {},
): SensitiveAuthConfig {
  return { apiKeys: [], ...overrides };
}

describe("authorizeSensitiveApi — dashboard key precedence", () => {
  it("accepts the dashboard key and names it as the actor", () => {
    const result = authorizeSensitiveApi(
      request("dash-secret"),
      config({ dashboardKey: "dash-secret" }),
      "mutate",
    );
    expect(result.ok).toBe(true);
    expect(result.actor).toBe("dashboard-key");
    expect(result.fingerprint).toMatch(/^[0-9a-f]{6}$/);
  });

  it("stops honouring the legacy key once a dashboard key is set", () => {
    const cfg = config({
      dashboardKey: "dash-secret",
      requiredKey: "bridge-secret",
      apiKeys: [{ label: "default", scope: "chat", key: "bridge-secret" }],
    });
    const denied = authorizeSensitiveApi(
      request("bridge-secret"),
      cfg,
      "sensitiveRead",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);
    expect(authorizeSensitiveApi(request("dash-secret"), cfg, "mutate").ok).toBe(
      true,
    );
  });

  it("refuses loopback callers once a dashboard key is set", () => {
    const denied = authorizeSensitiveApi(
      request(undefined, "127.0.0.1"),
      config({ dashboardKey: "dash-secret" }),
      "sensitiveRead",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(401);
      expect(denied.error).toContain("CURSOR_BRIDGE_DASHBOARD_KEY");
    }
  });
});

describe("authorizeSensitiveApi — key scopes", () => {
  it("lets an admin-scoped key in even when a dashboard key exists", () => {
    const result = authorizeSensitiveApi(
      request("sk-ops"),
      config({ dashboardKey: "dash-secret", apiKeys: [CHAT_KEY, ADMIN_KEY] }),
      "mutate",
    );
    expect(result.ok).toBe(true);
    expect(result.actor).toBe("ops");
  });

  it("refuses a chat-scoped key with 403 and explains the scope", () => {
    const denied = authorizeSensitiveApi(
      request("sk-ci"),
      config({ dashboardKey: "dash-secret", apiKeys: [CHAT_KEY] }),
      "sensitiveRead",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(403);
      expect(denied.error).toContain('scope "chat"');
      expect(denied.error).not.toContain("sk-ci");
    }
    expect(denied.actor).toBe("ci");
  });

  it("refuses a chat-scoped key even when no gate is configured", () => {
    const denied = authorizeSensitiveApi(
      request("sk-ci"),
      config({ apiKeys: [CHAT_KEY] }),
      "sensitiveRead",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);
  });
});

describe("authorizeSensitiveApi — legacy and loopback fallback", () => {
  it("keeps accepting CURSOR_BRIDGE_API_KEY when no dashboard key is set", () => {
    const result = authorizeSensitiveApi(
      request("bridge-secret", "10.0.0.5"),
      config({
        requiredKey: "bridge-secret",
        apiKeys: [{ label: "default", scope: "chat", key: "bridge-secret" }],
      }),
      "mutate",
    );
    expect(result.ok).toBe(true);
    expect(result.actor).toBe("bridge-api-key");
  });

  it("rejects a wrong bearer against the legacy key with 401", () => {
    const denied = authorizeSensitiveApi(
      request("wrong"),
      config({ requiredKey: "bridge-secret" }),
      "mutate",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.status).toBe(401);
      expect(denied.error).toContain("CURSOR_BRIDGE_API_KEY");
    }
  });

  it("allows unauthenticated loopback mutations and reads when nothing is set", () => {
    const mutate = authorizeSensitiveApi(request(), config(), "mutate");
    expect(mutate.ok).toBe(true);
    expect(mutate.actor).toBe("loopback");
    expect(
      authorizeSensitiveApi(
        request(undefined, "203.0.113.9"),
        config(),
        "sensitiveRead",
      ).ok,
    ).toBe(true);
  });

  it("refuses remote mutations when nothing is set", () => {
    const denied = authorizeSensitiveApi(
      request(undefined, "203.0.113.9"),
      config(),
      "mutate",
    );
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.status).toBe(403);
  });
});

describe("dashboardIsKeyProtected", () => {
  it("is true for a dashboard key, a legacy key or any admin-scoped key", () => {
    expect(dashboardIsKeyProtected(config({ dashboardKey: "d" }))).toBe(true);
    expect(dashboardIsKeyProtected(config({ requiredKey: "b" }))).toBe(true);
    expect(dashboardIsKeyProtected(config({ apiKeys: [ADMIN_KEY] }))).toBe(true);
  });

  it("is false for chat-only keys and for no keys at all", () => {
    expect(dashboardIsKeyProtected(config({ apiKeys: [CHAT_KEY] }))).toBe(false);
    expect(dashboardIsKeyProtected(config())).toBe(false);
  });
});
