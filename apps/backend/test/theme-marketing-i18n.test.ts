import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("theme, docs, marketing, and mascot specifications", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const marketingPath = join(root, "apps", "web", "src", "layouts", "MarketingPage.astro");
  const themeProviderPath = join(root, "apps", "frontend", "src", "components", "ThemeProvider.tsx");
  const homePath = join(root, "apps", "web", "src", "pages", "index.astro");
  const mascotJsPath = join(root, "apps", "web", "public", "assets", "mascot", "pet-mascot.js");
  const docsThemePath = join(root, "apps", "web", "src", "styles", "theme.css");

  it("shares consistent theme preference key across frontend app and web/astro", () => {
    const tpContent = readFileSync(themeProviderPath, "utf-8");
    const mpContent = readFileSync(marketingPath, "utf-8");

    // Both should use and synchronize the theme storage key
    expect(tpContent).toContain('shiba-theme');
    expect(mpContent).toContain('shiba-theme');
    expect(tpContent).toContain('defaultTheme="dark"');
    expect(mpContent).toContain('data-theme="dark"');
  });

  it("has dark-first fallback and dark mode support in MarketingPage and ThemeProvider", () => {
    const mpContent = readFileSync(marketingPath, "utf-8");
    expect(mpContent).toContain("data-theme");
    expect(mpContent).toContain("theme-toggle-btn");

    const docsTheme = readFileSync(docsThemePath, "utf-8");
    expect(docsTheme).toContain(":root[data-theme='dark']");
  });

  it("respects prefers-reduced-motion in mascot animations", () => {
    const mascotContent = readFileSync(mascotJsPath, "utf-8");
    expect(mascotContent).toContain("prefers-reduced-motion");
  });

  it("provides refined marketing copy with clear value proposition and approval gate guarantees", () => {
    const homeContent = readFileSync(homePath, "utf-8");
    expect(homeContent).toContain("approval");
    expect(homeContent).toContain("Cloudflare Sandbox");
    expect(homeContent).toContain("approval-gated");
    expect(homeContent).toContain("dither-sweep-beam");
  });
});
