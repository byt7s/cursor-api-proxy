import { describe, expect, it } from "vitest";
import {
  thoughtStreamDelta,
  withReasoningContent,
} from "./thought-mode.js";

describe("thought-mode helpers", () => {
  it("drop mode never attaches reasoning_content", () => {
    const message = withReasoningContent(
      { role: "assistant", content: "M" },
      "T",
      "drop",
    );
    expect(message).toEqual({ role: "assistant", content: "M" });
    expect("reasoning_content" in message).toBe(false);
  });

  it("reasoning mode attaches reasoning_content without altering content", () => {
    const message = withReasoningContent(
      { role: "assistant", content: "M" },
      "T",
      "reasoning",
    );
    expect(message).toEqual({
      role: "assistant",
      content: "M",
      reasoning_content: "T",
    });
  });

  it("stream delta is null when dropping", () => {
    expect(thoughtStreamDelta("T", "drop")).toBeNull();
    expect(thoughtStreamDelta("T", "reasoning")).toEqual({
      reasoning_content: "T",
    });
  });

  it("ignores empty / whitespace reasoning", () => {
    expect(
      withReasoningContent({ role: "assistant", content: "M" }, "  ", "reasoning"),
    ).toEqual({ role: "assistant", content: "M" });
    expect(thoughtStreamDelta("", "reasoning")).toBeNull();
  });
});
