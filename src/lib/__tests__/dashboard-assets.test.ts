import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The dashboard is built from `web/` into `public/dashboard/` and those files are
 * committed, so a missing or stale `pnpm build:web` breaks `GET /` at runtime.
 * These assertions fail in the repo (and in CI) instead of in the browser.
 */

const packageRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dashboardDir = path.join(packageRoot, "public", "dashboard");
const indexHtmlPath = path.join(dashboardDir, "index.html");

/** Every `/static/dashboard/...` URL referenced by the built shell. */
function referencedAssetUrls(html: string): string[] {
  const urls = html.match(/\/static\/dashboard\/assets\/[\w./-]+/g) ?? [];
  return [...new Set(urls)];
}

function assetFileNames(): string[] {
  const assetsDir = path.join(dashboardDir, "assets");
  if (!fs.existsSync(assetsDir)) return [];
  return fs.readdirSync(assetsDir).filter((name) => !name.startsWith("."));
}

describe("committed dashboard assets", () => {
  it("ships an index.html shell mounting the React app", () => {
    expect(fs.existsSync(indexHtmlPath)).toBe(true);
    const html = fs.readFileSync(indexHtmlPath, "utf8");
    expect(html).toContain('<div id="root">');
    expect(html).toContain("/static/dashboard/");
  });

  it("references at least one built script and stylesheet", () => {
    const urls = referencedAssetUrls(fs.readFileSync(indexHtmlPath, "utf8"));
    expect(urls.some((url) => url.endsWith(".js"))).toBe(true);
    expect(urls.some((url) => url.endsWith(".css"))).toBe(true);
  });

  it("resolves every referenced asset to a file on disk", () => {
    const urls = referencedAssetUrls(fs.readFileSync(indexHtmlPath, "utf8"));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) {
      // `/static/<rel>` is served from `public/<rel>` by admin-dashboard.ts.
      const rel = url.slice("/static/".length);
      const filePath = path.join(packageRoot, "public", rel);
      expect(fs.existsSync(filePath), `missing built asset for ${url}`).toBe(
        true,
      );
      expect(fs.statSync(filePath).size).toBeGreaterThan(0);
    }
  });

  it("has no orphaned assets left over from an older build", () => {
    const referenced = new Set(
      referencedAssetUrls(fs.readFileSync(indexHtmlPath, "utf8")).map((url) =>
        path.basename(url),
      ),
    );
    const orphans = assetFileNames().filter((name) => !referenced.has(name));
    expect(orphans, `run pnpm build:web and commit public/dashboard`).toEqual(
      [],
    );
  });
});
