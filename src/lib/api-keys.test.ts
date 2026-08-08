import { describe, expect, it } from "vitest";

import {
  apiKeyFingerprint,
  buildApiKeyRegistry,
  describeApiKeys,
  matchApiKey,
  parseApiKeys,
} from "./api-keys.js";

describe("parseApiKeys", () => {
  it("parses label:scope:key items", () => {
    const { entries, warnings } = parseApiKeys(
      "ci:chat:sk-ci-value, ops:admin:sk-ops-value",
    );
    expect(warnings).toEqual([]);
    expect(entries).toEqual([
      { label: "ci", scope: "chat", key: "sk-ci-value" },
      { label: "ops", scope: "admin", key: "sk-ops-value" },
    ]);
  });

  it("keeps colons inside the key itself", () => {
    const { entries } = parseApiKeys("svc:chat:aa:bb:cc");
    expect(entries[0]).toEqual({
      label: "svc",
      scope: "chat",
      key: "aa:bb:cc",
    });
  });

  it("returns nothing for empty or missing input", () => {
    expect(parseApiKeys(undefined).entries).toEqual([]);
    expect(parseApiKeys("   ").entries).toEqual([]);
  });

  it("warns and skips malformed, unknown-scope and duplicate entries", () => {
    const { entries, warnings } = parseApiKeys(
      "nokey,bad:root:sk-x,ok:chat:sk-1,ok:admin:sk-2,empty:chat:",
    );
    expect(entries).toEqual([{ label: "ok", scope: "chat", key: "sk-1" }]);
    expect(warnings).toHaveLength(4);
    expect(warnings.join("\n")).toContain("expected label:scope:key");
    expect(warnings.join("\n")).toContain('unknown scope "root"');
    expect(warnings.join("\n")).toContain('duplicate label "ok"');
    expect(warnings.join("\n")).toContain("empty key value");
  });

  it("never echoes key material in warnings", () => {
    const { warnings } = parseApiKeys("leaky:root:sk-super-secret");
    expect(warnings.join("\n")).not.toContain("sk-super-secret");
  });
});

describe("apiKeyFingerprint", () => {
  it("is a stable 6-char sha256 prefix that hides the key", () => {
    const fingerprint = apiKeyFingerprint("sk-ci-value");
    expect(fingerprint).toMatch(/^[0-9a-f]{6}$/);
    expect(fingerprint).toBe(apiKeyFingerprint("sk-ci-value"));
    expect(fingerprint).not.toBe(apiKeyFingerprint("sk-ci-valuf"));
  });
});

describe("describeApiKeys", () => {
  it("exposes label, scope and fingerprint but never the key", () => {
    const described = describeApiKeys([
      { label: "ops", scope: "admin", key: "sk-ops-value" },
    ]);
    expect(described).toEqual([
      {
        label: "ops",
        scope: "admin",
        fingerprint: apiKeyFingerprint("sk-ops-value"),
      },
    ]);
    expect(JSON.stringify(described)).not.toContain("sk-ops-value");
  });
});

describe("buildApiKeyRegistry", () => {
  it("registers the legacy key with chat scope ahead of scoped entries", () => {
    const registry = buildApiKeyRegistry("legacy-secret", [
      { label: "ops", scope: "admin", key: "sk-ops" },
    ]);
    expect(registry).toEqual([
      { label: "default", scope: "chat", key: "legacy-secret" },
      { label: "ops", scope: "admin", key: "sk-ops" },
    ]);
  });

  it("drops a scoped entry that repeats the legacy key value", () => {
    const registry = buildApiKeyRegistry("shared", [
      { label: "ops", scope: "admin", key: "shared" },
    ]);
    expect(registry).toHaveLength(1);
    expect(registry[0]!.label).toBe("default");
  });

  it("returns an empty registry when nothing is configured", () => {
    expect(buildApiKeyRegistry(undefined, [])).toEqual([]);
  });
});

describe("matchApiKey", () => {
  const entries = [
    { label: "ci", scope: "chat" as const, key: "sk-ci" },
    { label: "ops", scope: "admin" as const, key: "sk-ops" },
  ];

  it("finds the matching entry", () => {
    expect(matchApiKey(entries, "sk-ops")?.label).toBe("ops");
  });

  it("returns undefined for unknown, empty and prefix tokens", () => {
    expect(matchApiKey(entries, "sk-nope")).toBeUndefined();
    expect(matchApiKey(entries, "")).toBeUndefined();
    expect(matchApiKey(entries, undefined)).toBeUndefined();
    expect(matchApiKey(entries, "sk-o")).toBeUndefined();
  });
});
