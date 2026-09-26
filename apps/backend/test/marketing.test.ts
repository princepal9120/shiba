/**
 * Guards the custom landing page against a Starlight upgrade reclaiming the
 * index route. Reads the build output, so it only runs after `pnpm build`.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const indexPath = join(import.meta.dirname, "..", "..", "..", "public", "index.html");
// Skipping is honest here; passing on a missing artifact would not be.
const built = existsSync(indexPath);

describe.skipIf(!built)("marketing landing page", () => {
  const html = () => readFileSync(indexPath, "utf-8");

  test("renders the custom landing page, not the Starlight splash", () => {
    const markup = html();
    expect(markup).toContain("Shiba - Your AI software engineer");
    expect(markup).toContain("Your AI software engineer.");
    expect(markup).toContain("Approval before execution");
    expect(markup).toContain("shiba.workspace");
    expect(markup).not.toContain("manga-panel");
    expect(markup).toContain('data-theme="dark"');
    expect(markup).toContain("theme-toggle-btn");
    expect(markup).toContain("AGPL-3.0");
    for (const harness of ["OpenCode", "Claude Code", "Codex", "Devin CLI"]) {
      expect(markup).toContain(harness);
    }
  });

  test("every referenced asset exists in the build output", () => {
    const refs = [...html().matchAll(/\/assets\/[\w-]+\/[\w.-]+/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((ref) => !existsSync(join(import.meta.dirname, "..", "..", "..", "public", ref)));
    expect(missing).toEqual([]);
  });

  test("carries no Capy branding or scraped assets", () => {
    expect(html().toLowerCase()).not.toContain("capy");
  });
});
