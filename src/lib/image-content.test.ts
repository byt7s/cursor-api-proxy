import { describe, expect, it } from "vitest";

import {
  messagesContainImages,
  responsesInputContainsImages,
  stripImagesFromMessages,
  stripImagesFromResponsesInput,
} from "./image-content.js";

describe("image-content", () => {
  it("detects OpenAI image_url parts", () => {
    expect(
      messagesContainImages([
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "https://x/y.png" } },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("detects Anthropic image blocks", () => {
    expect(
      messagesContainImages([
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "aa" },
            },
          ],
        },
      ]),
    ).toBe(true);
  });

  it("strips image parts and keeps text", () => {
    const stripped = stripImagesFromMessages([
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "image_url", image_url: { url: "https://x/y.png" } },
        ],
      },
    ]);
    expect(stripped).toEqual([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
  });

  it("detects and strips Responses input images", () => {
    const input = [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "hi" },
          { type: "input_image", image_url: "https://x/y.png" },
        ],
      },
    ];
    expect(responsesInputContainsImages(input)).toBe(true);
    expect(stripImagesFromResponsesInput(input)).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hi" }],
      },
    ]);
  });
});
