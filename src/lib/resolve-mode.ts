import type { BridgeConfig } from "./config.js";
import {
  parseExecutionModeFromRequest,
  type CursorExecutionMode,
} from "./execution-mode.js";

export type ResolveRequestModeOptions = {
  /** When tools/functions are present and no explicit mode was set, prefer agent. */
  hasTools?: boolean;
};

export function resolveRequestMode(
  config: BridgeConfig,
  headerMode: string | string[] | undefined,
  bodyMode: unknown,
  options: ResolveRequestModeOptions = {},
): CursorExecutionMode {
  if (bodyMode !== undefined && bodyMode !== null) {
    if (typeof bodyMode !== "string") {
      throw new Error("Request body mode must be a string");
    }
    if (bodyMode.trim()) {
      return parseExecutionModeFromRequest(bodyMode, "body.mode");
    }
  }
  const h = Array.isArray(headerMode) ? headerMode[0] : headerMode;
  if (typeof h === "string" && h.trim()) {
    return parseExecutionModeFromRequest(h, "X-Cursor-Mode header");
  }
  if (options.hasTools) {
    return "agent";
  }
  return config.mode;
}
