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
  cancelled: false,
  disposed: false,
  createdWith: undefined as Record<string, unknown> | undefined,
};

vi.mock("@cursor/sdk", () => ({
  Agent: {
    create: vi.fn(async (options: Record<string, unknown>) => {
      state.createdWith = options;
      if (state.createError) throw state.createError;
      return {
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
  state.cancelled = false;
  state.disposed = false;
  state.createdWith = undefined;
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
});
