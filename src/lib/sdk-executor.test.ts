import { beforeEach, describe, expect, it, vi } from "vitest";

type Delta = { type: string; text: string };

const state = {
  deltas: [] as Delta[],
  waitResult: { status: "finished", result: "hello" } as {
    status: string;
    result?: string;
    error?: { message: string };
  },
  createError: undefined as Error | undefined,
  resumeError: undefined as Error | undefined,
  cancelled: false,
  disposed: false,
  createdWith: undefined as Record<string, unknown> | undefined,
  resumedWith: undefined as { agentId: string; options: Record<string, unknown> } | undefined,
  createCalls: 0,
  resumeCalls: 0,
  nextAgentId: "agent_created",
};

function makeAgent(agentId: string) {
  return {
    agentId,
    [Symbol.asyncDispose]: async () => {
      state.disposed = true;
    },
    send: async (
      _prompt: string,
      sendOptions: { onDelta?: (a: { update: Delta }) => void },
    ) => {
      for (const update of state.deltas) sendOptions.onDelta?.({ update });
      return {
        id: "run_test",
        supports: () => true,
        cancel: async () => {
          state.cancelled = true;
          state.waitResult = { status: "cancelled" };
        },
        wait: async () => state.waitResult,
      };
    },
  };
}

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(async (options: Record<string, unknown>) => {
      state.createCalls += 1;
      state.createdWith = options;
      if (state.createError) throw state.createError;
      return makeAgent(state.nextAgentId);
    }),
    resume: vi.fn(async (agentId: string, options: Record<string, unknown>) => {
      state.resumeCalls += 1;
      state.resumedWith = { agentId, options };
      if (state.resumeError) throw state.resumeError;
      return makeAgent(agentId);
    }),
  },
}));

const { runSdkAgent, resetSdkModuleForTests } = await import("./sdk-executor.js");

function baseOptions(overrides: Record<string, unknown> = {}) {
  return {
    prompt: "hi",
    cursorModel: "cursor-grok-4.5-high-fast",
    cwd: "/tmp/ws",
    apiKey: "crsr_test",
    timeoutMs: 0,
    ...overrides,
  } as Parameters<typeof runSdkAgent>[0];
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetSdkModuleForTests();
  state.deltas = [];
  state.waitResult = { status: "finished", result: "hello" };
  state.createError = undefined;
  state.resumeError = undefined;
  state.cancelled = false;
  state.disposed = false;
  state.createdWith = undefined;
  state.resumedWith = undefined;
  state.createCalls = 0;
  state.resumeCalls = 0;
  state.nextAgentId = "agent_created";
});

describe("runSdkAgent", () => {
  it("returns final text and disposes the agent", async () => {
    const result = await runSdkAgent(baseOptions());
    expect(result).toMatchObject({ code: 0, stdout: "hello", stderr: "" });
    expect(state.disposed).toBe(true);
  });

  it("passes parameterized model and refuses ambient settings", async () => {
    await runSdkAgent(baseOptions());
    expect(state.createdWith?.model).toEqual({
      id: "grok-4.5",
      params: [
        { id: "effort", value: "high" },
        { id: "fast", value: "true" },
      ],
    });
    expect(state.createdWith?.local).toMatchObject({
      cwd: "/tmp/ws",
      settingSources: [],
    });
  });

  it("forwards text and thought deltas", async () => {
    state.deltas = [
      { type: "thinking-delta", text: "pondering" },
      { type: "text-delta", text: "he" },
      { type: "text-delta", text: "llo" },
    ];
    const chunks: string[] = [];
    const thoughts: string[] = [];
    const result = await runSdkAgent(
      baseOptions({
        onChunk: (t: string) => chunks.push(t),
        onThought: (t: string) => thoughts.push(t),
      }),
    );
    expect(chunks).toEqual(["he", "llo"]);
    expect(thoughts).toEqual(["pondering"]);
    expect(result.reasoning).toBe("pondering");
  });

  it("maps run errors to failureText", async () => {
    state.waitResult = { status: "error", error: { message: "boom" } };
    const result = await runSdkAgent(baseOptions());
    expect(result).toMatchObject({
      code: 1,
      stderr: "boom",
      failureText: "boom",
    });
  });

  it("surfaces create failures without hanging", async () => {
    state.createError = new Error("no key");
    const result = await runSdkAgent(baseOptions());
    expect(result.failureText).toContain("no key");
  });

  it("returns agentId from a successful create", async () => {
    state.nextAgentId = "agent_fresh_123";
    const result = await runSdkAgent(baseOptions());
    expect(result.agentId).toBe("agent_fresh_123");
    expect(state.resumeCalls).toBe(0);
    expect(state.createCalls).toBe(1);
  });

  it("resumes an existing agent when resumeAgentId is set", async () => {
    const result = await runSdkAgent(
      baseOptions({ resumeAgentId: "agent_sticky" }),
    );
    expect(result).toMatchObject({ code: 0, stdout: "hello", agentId: "agent_sticky" });
    expect(state.resumeCalls).toBe(1);
    expect(state.createCalls).toBe(0);
    expect(state.resumedWith?.agentId).toBe("agent_sticky");
    expect(state.resumedWith?.options).toMatchObject({
      apiKey: "crsr_test",
      local: { cwd: "/tmp/ws", settingSources: [] },
    });
  });

  it("falls back to Agent.create when Agent.resume fails", async () => {
    state.resumeError = new Error("agent gone");
    state.nextAgentId = "agent_after_resume_fail";
    const result = await runSdkAgent(
      baseOptions({ resumeAgentId: "agent_stale" }),
    );
    expect(result).toMatchObject({
      code: 0,
      stdout: "hello",
      agentId: "agent_after_resume_fail",
    });
    expect(state.resumeCalls).toBe(1);
    expect(state.createCalls).toBe(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("Agent.resume(agent_stale) failed"),
    );
  });
});
