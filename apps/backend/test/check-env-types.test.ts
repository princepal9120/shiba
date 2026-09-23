import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");

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

describe("check-env-types: binding coverage (M1/M2)", () => {
  it("fails when version_metadata is declared but missing from Env", () => {
    const w = MATCHING_WRANGLER.replace(
      `"vars2_unused": 0,`,
      `"version_metadata": { "binding": "CF_VERSION_METADATA" },
  "vars2_unused": 0,`,
    );
    const out = runCheck(writePair(w, MATCHING_ENV));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("CF_VERSION_METADATA");
  });

  it("fails on bindings declared inside env.<name> sections", () => {
    const w = MATCHING_WRANGLER.replace(
      `"vars2_unused": 0,`,
      `"env": { "staging": { "vars": { "STAGING_ONLY": "x" } } },
  "vars2_unused": 0,`,
    );
    const out = runCheck(writePair(w, MATCHING_ENV));
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("STAGING_ONLY");
  });

  it("counts every declared binding kind (kv, r2, queues.producers, wasm_modules)", () => {
    const w = MATCHING_WRANGLER.replace(
      `"vars2_unused": 0,`,
      `"kv_namespaces": [{ "binding": "MY_KV", "id": "abc" }],
  "r2_buckets": [{ "binding": "MY_R2", "bucket_name": "b" }],
  "queues": { "producers": [{ "binding": "MY_Q", "queue": "q" }] },
  "wasm_modules": { "MY_WASM": "./m.wasm" },
  "vars2_unused": 0,`,
    );
    const env = MATCHING_ENV.replace(
      "  FOO: string;",
      `  FOO: string;
  MY_KV: KVNamespace;
  MY_R2: R2Bucket;
  MY_Q: Queue;
  MY_WASM: WebAssembly.Module;`,
    );
    const out = runCheck(writePair(w, env));
    expect(out.status).toBe(0);
    // and dropping one from Env must fail
    const envMissing = env.replace("  MY_KV: KVNamespace;\n", "");
    const out2 = runCheck(writePair(w, envMissing));
    expect(out2.status).toBe(1);
    expect(out2.stderr).toContain("MY_KV");
  });

  it("honors assets.binding as the declared name instead of ASSETS", () => {
    const w = MATCHING_WRANGLER.replace(
      `"assets": { "directory": "./public" },`,
      `"assets": { "directory": "./public", "binding": "STATIC_ASSETS" },`,
    );
    const env = MATCHING_ENV.replace("  ASSETS: Fetcher;", "  STATIC_ASSETS: Fetcher;");
    expect(runCheck(writePair(w, env)).status).toBe(0);
    // with a custom binding name, env.ASSETS is no longer the right field
    expect(runCheck(writePair(w, MATCHING_ENV)).status).toBe(1);
  });
});

describe("check-env-types: parser hardening (L1/L2)", () => {
  it("parses a trailing comma immediately before a // comment", () => {
    const w = `{
      "name": "w",
      "vars": { "FOO": "a", // note
      },
      "ai": { "binding": "AI" },
    }`;
    const env = `export interface Env { AI: Ai; FOO: string; }`;
    const out = runCheck(writePair(w, env));
    expect(out.status).toBe(0);
  });

  it("handles // inside quoted strings without eating the value", () => {
    const w = `{
      "name": "w",
      "$schema": "https://example.com/x.json",
      "vars": { "FOO": "https://v", },
    }`;
    const env = `export interface Env { FOO: string; }`;
    const out = runCheck(writePair(w, env));
    expect(out.status).toBe(0);
  });

  it("supports readonly fields, extends, and nested type literals", () => {
    const w = `{
      "name": "w",
      "vars": { "FOO": "a", "BAR": "b" },
    }`;
    const env = `interface BaseEnv { IGNORED?: string; }
export interface Env extends BaseEnv {
  readonly FOO: string;
  BAR: string;
  CONFIG: { nested: string, deep?: { x: number } };
}
`;
    const out = runCheck(writePair(w, env));
    // CONFIG is required-but-nested: not declared in wrangler -> should fail on CONFIG,
    // but `nested`/`deep`/`x` must NOT appear as missing required fields.
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("CONFIG");
    expect(out.stderr).not.toContain("nested");
    expect(out.stderr).not.toContain("deep");
  });
});
