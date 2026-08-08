import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webRoot = fileURLToPath(new URL(".", import.meta.url));

/**
 * Built assets land in `public/dashboard/` so the existing `/static/*` mapping
 * in `src/lib/admin-dashboard.ts` resolves them at `/static/dashboard/...`.
 * `emptyOutDir` only wipes that subdirectory, never the rest of `public/`.
 */
export default defineConfig({
  root: webRoot,
  base: "/static/dashboard/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../public/dashboard", import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: "es2020",
  },
});
