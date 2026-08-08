import { describe, expect, it, beforeEach } from "vitest";

import {
  bindSessionAffinity,
  clearSessionAffinity,
  clearSessionAgentId,
  getSessionAffinity,
  resetSessionAffinityForTests,
  resolveConversationId,
} from "./session-affinity.js";

describe("resolveConversationId", () => {
  it("prefers X-Cursor-Conversation-Id header", () => {
    expect(
      resolveConversationId(
        { "x-cursor-conversation-id": "conv-header" },
        { conversation_id: "conv-body", user: "user-field" },
      ),
    ).toBe("conv-header");
  });

  it("uses body conversation_id next", () => {
    expect(
      resolveConversationId({}, { conversation_id: "conv-body", user: "u" }),
    ).toBe("conv-body");
  });

  it("falls back to opaque user field", () => {
    expect(
      resolveConversationId({}, { user: "librechat-thread-abc12345" }),
    ).toBe("librechat-thread-abc12345");
  });

  it("ignores email-like user fields", () => {
    expect(resolveConversationId({}, { user: "a@b.com" })).toBeUndefined();
  });
});

describe("session affinity map", () => {
  beforeEach(() => {
    resetSessionAffinityForTests();
  });

  it("binds and returns affinity", () => {
    bindSessionAffinity("c1", {
      configDir: "/acc/a",
      agentId: "agent_1",
      engine: "sdk",
    });
    expect(getSessionAffinity("c1")).toMatchObject({
      configDir: "/acc/a",
      agentId: "agent_1",
      engine: "sdk",
    });
  });

  it("clears agent id while keeping account pin", () => {
    bindSessionAffinity("c1", {
      configDir: "/acc/a",
      agentId: "agent_1",
      engine: "sdk",
    });
    clearSessionAgentId("c1");
    expect(getSessionAffinity("c1")).toMatchObject({
      configDir: "/acc/a",
      agentId: undefined,
      engine: "sdk",
    });
  });

  it("clears entire affinity for cross-account replay", () => {
    bindSessionAffinity("c1", {
      configDir: "/acc/a",
      agentId: "agent_1",
      engine: "sdk",
    });
    clearSessionAffinity("c1");
    expect(getSessionAffinity("c1")).toBeUndefined();
  });
});
