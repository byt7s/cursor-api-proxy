import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

/**
 * Node 22+ exposes a stub `localStorage` global that shadows the jsdom one and
 * has none of the Storage methods. Swap in a real in-memory Storage so the
 * dashboard's persistence behaves the way it does in a browser.
 */
function installStorage(key: "localStorage" | "sessionStorage"): void {
  const existing = window[key] as Storage | undefined;
  if (existing && typeof existing.clear === "function") return;

  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (name) => entries.get(String(name)) ?? null,
    key: (index) => Array.from(entries.keys())[index] ?? null,
    removeItem: (name) => void entries.delete(String(name)),
    setItem: (name, value) => void entries.set(String(name), String(value)),
  };

  Object.defineProperty(window, key, {
    configurable: true,
    writable: true,
    value: storage,
  });
}

installStorage("localStorage");
installStorage("sessionStorage");

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
