import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert";

// Local test runner fallback
const runnerIt = (name: string, fn: () => void) => {
  fn();
  console.log("PASS:", name);
};
const runnerDescribe = (name: string, fn: () => void) => {
  fn();
};
const runnerExpect = (actual: any) => ({
  toContain: (expected: string) => {
    assert.ok(typeof actual === "string" && actual.includes(expected), `Expected ${actual} to contain ${expected}`);
  },
});

runnerDescribe("theme, docs, marketing, i18n & mascot specifications", () => {
  const root = join(import.meta.dirname, "..", "..", "..");
  const marketingPath = join(root, "apps", "web", "src", "layouts", "MarketingPage.astro");
  const themeProviderPath = join(root, "apps", "frontend", "src", "components", "ThemeProvider.tsx");
  const homePath = join(root, "apps", "web", "src", "pages", "index.astro");
  const mascotJsPath = join(root, "apps", "web", "public", "assets", "mascot", "pet-mascot.js");
  const docsThemePath = join(root, "apps", "web", "src", "styles", "theme.css");

  runnerIt("shares consistent theme preference key across frontend app and web/astro", () => {
    const tpContent = readFileSync(themeProviderPath, "utf-8");
    const mpContent = readFileSync(marketingPath, "utf-8");

    // Both should use and synchronize the theme storage key
    runnerExpect(tpContent).toContain('shiba-theme');
    runnerExpect(mpContent).toContain('shiba-theme');
  });

  runnerIt("has dark-first fallback and dark mode support in MarketingPage and ThemeProvider", () => {
    const mpContent = readFileSync(marketingPath, "utf-8");
    runnerExpect(mpContent).toContain("data-theme");
    runnerExpect(mpContent).toContain("theme-toggle-btn");

    const docsTheme = readFileSync(docsThemePath, "utf-8");
    runnerExpect(docsTheme).toContain(":root[data-theme='dark']");
  });

  runnerIt("supports en and hi-IN locales in marketing layout", () => {
    const mpContent = readFileSync(marketingPath, "utf-8");
    runnerExpect(mpContent).toContain('lang={lang}');
    runnerExpect(mpContent).toContain('locale-toggle');
  });

  runnerIt("respects prefers-reduced-motion in mascot animations", () => {
    const mascotContent = readFileSync(mascotJsPath, "utf-8");
    runnerExpect(mascotContent).toContain("prefers-reduced-motion");
  });

  runnerIt("provides refined marketing copy with clear value proposition and approval gate guarantees", () => {
    const homeContent = readFileSync(homePath, "utf-8");
    runnerExpect(homeContent).toContain("approval");
    runnerExpect(homeContent).toContain("Cloudflare Sandbox");
    runnerExpect(homeContent).toContain("Zero-Trust Boundary");
  });
});
