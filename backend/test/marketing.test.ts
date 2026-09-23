/**
 * Guards the custom landing page against a Starlight upgrade reclaiming the
 * index route. Reads the build output, so it only runs after `pnpm build`.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const indexPath = join(process.cwd(), "public", "index.html");
// Skipping is honest here; passing on a missing artifact would not be.
const built = existsSync(indexPath);

describe.skipIf(!built)("marketing landing page", () => {
  const html = () => readFileSync(indexPath, "utf-8");

  test("renders the custom landing page, not the Starlight splash", () => {
    const markup = html();
    expect(markup).toContain("AI Coworker - The best AI software engineer");
    expect(markup).toContain("THE BEST SELF-HOSTED");
    expect(markup).toContain("AI SOFTWARE ENGINEER");
    expect(markup).toContain("grid-bg");
    expect(markup).toContain("01. Approval-Gated");
  });

  test("every referenced asset exists in the build output", () => {
    const refs = [...html().matchAll(/\/assets\/[\w-]+\/[\w.-]+/g)].map((m) => m[0]);
    expect(refs.length).toBeGreaterThan(0);
    const missing = refs.filter((ref) => !existsSync(join(process.cwd(), "public", ref)));
    expect(missing).toEqual([]);
  });

  test("carries no Capy branding or scraped assets", () => {
    expect(html().toLowerCase()).not.toContain("capy");
  });
});

