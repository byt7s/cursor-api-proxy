/**
 * Detect / optionally strip image content parts in OpenAI and Anthropic
 * message payloads. Default policy is reject (clear 400); operators can set
 * CURSOR_BRIDGE_IGNORE_IMAGES=true to strip placeholders and continue.
 */

export const IMAGES_NOT_SUPPORTED_CODE = "images_not_supported";

export const IMAGES_NOT_SUPPORTED_MESSAGE =
  "Image content is not supported by this Cursor bridge. Send text-only messages, or set CURSOR_BRIDGE_IGNORE_IMAGES=true to strip images and continue.";

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;
  const type = typeof p.type === "string" ? p.type : "";
  return (
    type === "image_url" ||
    type === "image" ||
    type === "input_image" ||
    type === "output_image"
  );
}

function contentHasImage(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some(isImagePart);
}

/** True when any chat/messages content part is an image. */
export function messagesContainImages(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (contentHasImage((message as { content?: unknown }).content)) {
      return true;
    }
  }
  return false;
}

/** True for OpenAI Responses `input` that includes image parts. */
export function responsesInputContainsImages(input: unknown): boolean {
  if (typeof input === "string") return false;
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (isImagePart(record)) return true;
    if (contentHasImage(record.content)) return true;
  }
  return false;
}

function stripContentImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((part) => !isImagePart(part));
}

/** Drop image parts; leave text (and other non-image) parts in place. */
export function stripImagesFromMessages<T>(messages: T): T {
  if (!Array.isArray(messages)) return messages;
  return messages.map((message) => {
    if (!message || typeof message !== "object") return message;
    const m = message as Record<string, unknown>;
    if (!contentHasImage(m.content)) return message;
    return { ...m, content: stripContentImages(m.content) };
  }) as T;
}

export function stripImagesFromResponsesInput(input: unknown): unknown {
  if (typeof input === "string" || !Array.isArray(input)) return input;
  return input
    .filter((item) => !isImagePart(item))
    .map((item) => {
      if (!item || typeof item !== "object") return item;
      const record = item as Record<string, unknown>;
      if (!contentHasImage(record.content)) return item;
      return { ...record, content: stripContentImages(record.content) };
    });
}
