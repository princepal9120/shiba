import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

function runCheck(extraArgs: string[] = []) {
  return spawnSync("node", ["scripts/check-cf-patterns-doc.mjs", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function writeDoc(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cf-patterns-doc-"));
  const path = join(dir, "doc.md");
  writeFileSync(path, contents);
  return path;
}

describe("cf-patterns doc checker", () => {
  it("passes on the real decision doc", () => {
    const out = runCheck();
    expect(out.status).toBe(0);
  });

  it("fails when a SKIP row lacks a flip criterion", () => {
    const doc = writeDoc(`| Pattern | Verdict | Rationale | Flip criterion |
| --- | --- | --- | --- |
| Fibers | SKIP | no runtime for it | — |
`);
    const out = runCheck([`--doc=${doc}`]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("Fibers");
  });

  it("fails when a COPY row names a file that does not exist", () => {
    const doc = writeDoc(`| Pattern | Verdict | Rationale | Flip criterion |
| --- | --- | --- | --- |
| Widget | COPY | landed in src/nope-does-not-exist.ts | — |
`);
    const out = runCheck([`--doc=${doc}`]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("src/nope-does-not-exist.ts");
  });
});
