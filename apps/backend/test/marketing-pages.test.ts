import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..", "web", "dist");
const built = existsSync(join(root, "waitlist", "index.html"));

describe.skipIf(!built)("new marketing pages", () => {
  const page = (path: string) => readFileSync(join(root, path), "utf8");

  it("publishes distinct, canonical and indexable story and signup pages with light and dark theme support", () => {
    const why = page("why-shiba/index.html");
    const waitlist = page("waitlist/index.html");
    expect(why).toContain('href="https://tryshiba.dev/why-shiba/"');
    expect(waitlist).toContain('href="https://tryshiba.dev/waitlist/"');
    expect(why).toContain("How Shiba Compares to Devin Cloud");
    expect(why).not.toMatch(/cloudroom/i);
    expect(waitlist).toContain('id="waitlist-form"');
    expect(waitlist).toContain('name="consent"');
    expect(waitlist).toContain('name="interest"');
    expect(waitlist).toContain("/api/waitlist");
    // Theme toggle support
    expect(waitlist).toContain("theme-toggle-btn");
    expect(why).toContain("theme-toggle-btn");
    expect(waitlist).toContain("shiba-theme");
    expect(why).toContain("I loved sending work to the cloud");
    expect(why).toContain("AGPL-3.0-only");
  });
});
