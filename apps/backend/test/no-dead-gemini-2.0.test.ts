import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const BACKEND_ROOT = join(__dirname, "..");

/**
 * `gemini-2.0-flash` retired 2026-06-01. It is legitimate to keep the
 * literal in exactly two places: the retired-model deny list
 * (coding-model.ts) and its test — everywhere else it would mean a
 * dead fallback that fires silently whenever CODING_MODEL is unset.
 */
const ALLOWED_FILES = new Set([
  "src/coding-model.ts",
  "test/coding-model.test.ts",
  // This file's own path — it necessarily mentions the retired id in
  // code comments/strings while describing what it checks for.
  "test/no-dead-gemini-2.0.test.ts",
]);

/** Built from parts so this file doesn't itself trip its own scan. */
const RETIRED_MARKER = ["gemini-2", "0"].join(".");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("no dead gemini-2.0 default", () => {
  it("only the retired-model guard references gemini-2.0", () => {
    const offenders: string[] = [];
    for (const dir of ["src", "test"]) {
      for (const file of walk(join(BACKEND_ROOT, dir))) {
        const relPath = relative(BACKEND_ROOT, file).split("\\").join("/");
        if (ALLOWED_FILES.has(relPath)) continue;
        const contents = readFileSync(file, "utf8");
        if (contents.includes(RETIRED_MARKER)) offenders.push(relPath);
      }
    }
    expect(offenders).toEqual([]);
  });
});
