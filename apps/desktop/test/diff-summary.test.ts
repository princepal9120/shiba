import { describe, expect, it } from "vitest";
import { summarizeUnifiedDiff } from "../src/diff-summary.js";

const PATCH = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

describe("summarizeUnifiedDiff", () => {
  it("counts files, hunks, and line changes", () => {
    expect(summarizeUnifiedDiff(PATCH)).toEqual({
      ok: true,
      summary: { files: ["src/cart.ts"], hunks: 1, additions: 1, deletions: 1 },
    });
  });

  it("rejects empty text, prose, and a null byte", () => {
    expect(summarizeUnifiedDiff("")).toEqual({ ok: false, error: "Diff is empty." });
    expect(summarizeUnifiedDiff("hello")).toEqual({
      ok: false,
      error: "Diff is not a unified patch.",
    });
    expect(summarizeUnifiedDiff("diff --git a/a b/a\0")).toEqual({
      ok: false,
      error: "Diff is not text.",
    });
  });
});
