import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");

function runCheck(extraArgs: string[] = []) {
  return spawnSync("node", ["scripts/check-env-types.mjs", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

function writePair(wrangler: string, env: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), "env-types-"));
  const w = join(dir, "wrangler.jsonc");
  const e = join(dir, "env.ts");
  writeFileSync(w, wrangler);
  writeFileSync(e, env);
  return [`--wrangler=${w}`, `--env=${e}`];
}

const MATCHING_WRANGLER = `{
  "name": "w",
  // comment lines must not break the JSONC parse
  "vars": { "FOO": "a", },
  "ai": { "binding": "AI" },
  "durable_objects": { "bindings": [{ "name": "DO_A", "class_name": "DoA" }], },
  "assets": { "directory": "./public" },
  "containers": [{ "class_name": "DoA", "instance_type": "standard-1" }],
  "vars2_unused": 0,
}`;

const MATCHING_ENV = `export interface Env {
  AI: Ai;
  DO_A: DurableObjectNamespace;
  ASSETS: Fetcher;
  FOO: string;
  /** Optional extras are allowed (secrets, runtime vars). */
  EXTRA?: string;
}
`;

describe("check-env-types", () => {
  it("passes on the real repo (wrangler.jsonc <-> src/env.ts)", () => {
    const out = runCheck();
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("env bindings in sync");
  });

  it("passes on a matching fixture pair, allowing optional extras", () => {
    const out = runCheck(writePair(MATCHING_WRANGLER, MATCHING_ENV));
    expect(out.status).toBe(0);
  });

  it("fails when a wrangler binding is missing from env.ts", () => {
    const env = MATCHING_ENV.replace("  FOO: string;\n", "");
    const out = runCheck(writePair(MATCHING_WRANGLER, env));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("FOO");
    expect(out.stderr).toContain("drift");
  });

  it("fails when a non-optional Env field is missing from wrangler.jsonc", () => {
    const env = MATCHING_ENV.replace("  EXTRA?: string;", "  REQUIRED_THING: string;");
    const out = runCheck(writePair(MATCHING_WRANGLER, env));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("REQUIRED_THING");
  });

  it("fails when vars.INSTANCE_TYPE disagrees with containers[].instance_type", () => {
    const w = MATCHING_WRANGLER.replace(
      `"vars": { "FOO": "a", }`,
      `"vars": { "FOO": "a", "INSTANCE_TYPE": "standard-2" }`,
    );
    const env = MATCHING_ENV.replace("  FOO: string;", "  FOO: string;\n  INSTANCE_TYPE?: string;");
    const out = runCheck(writePair(w, env));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("INSTANCE_TYPE");
  });
});
