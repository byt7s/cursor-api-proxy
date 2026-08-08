import { resolve } from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Two projects behind a single `vitest run`: the Node server suite in `src/`
 * and the jsdom dashboard suite in `web/`.
 */
export default defineConfig({
  test: {
    projects: [
      {
        resolve: {
          alias: {
            // Ensure .js extensions resolve for ESM
            "#test": resolve(__dirname, "src"),
          },
        },
        test: {
          name: "server",
          globals: true,
          environment: "node",
          include: ["src/**/*.test.ts"],
        },
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          globals: true,
          environment: "jsdom",
          include: ["web/**/*.test.{ts,tsx}"],
          setupFiles: ["web/test/setup.ts"],
        },
      },
    ],
  },
});
