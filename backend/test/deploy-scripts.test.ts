import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const FIXTURES = join(ROOT, "backend", "test", "fixtures");

function run(script: string, args: string[] = []) {
  return spawnSync("node", [`scripts/${script}`, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

describe("plan-deploy", () => {
  it("parses a clean dry-run fixture and exits 0", () => {
    const out = run("plan-deploy.mjs", [
      `--fixture=${join(FIXTURES, "dryrun-ok.txt")}`,
      `--wrangler=${join(FIXTURES, "plan-wrangler.jsonc")}`,
    ]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("This deploy will:");
    expect(out.stdout).toContain("bind JobRunner");
    expect(out.stdout).toContain("deploy container fixture-sandbox");
    expect(out.stdout).toContain("plan matches wrangler.jsonc");
  });

  it("warns but exits 0 on a removed binding and an unexpected var", () => {
    const out = run("plan-deploy.mjs", [
      `--fixture=${join(FIXTURES, "dryrun-drifted.txt")}`,
      `--wrangler=${join(FIXTURES, "plan-wrangler.jsonc")}`,
    ]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("missing");
    expect(out.stderr).toContain("JobRunner");
    expect(out.stderr).toContain("unexpected");
    expect(out.stderr).toContain("ROGUE_VAR");
  });

  it("exits 1 on the same drift with --strict", () => {
    const out = run("plan-deploy.mjs", [
      `--fixture=${join(FIXTURES, "dryrun-drifted.txt")}`,
      `--wrangler=${join(FIXTURES, "plan-wrangler.jsonc")}`,
      "--strict",
    ]);
    expect(out.status).toBe(1);
  });

  it("detects a kind change: declared KV shown as Environment Variable (M3)", () => {
    const out = run("plan-deploy.mjs", [
      `--fixture=${join(FIXTURES, "dryrun-kind-drift.txt")}`,
      `--wrangler=${join(FIXTURES, "plan-wrangler-kv.jsonc")}`,
    ]);
    expect(out.status).toBe(0);
    expect(out.stderr).toContain("changed");
    expect(out.stderr).toContain("MY_KV");
    const strict = run("plan-deploy.mjs", [
      `--fixture=${join(FIXTURES, "dryrun-kind-drift.txt")}`,
      `--wrangler=${join(FIXTURES, "plan-wrangler-kv.jsonc")}`,
      "--strict",
    ]);
    expect(strict.status).toBe(1);
  });

  it("prints help", () => {
    const out = run("plan-deploy.mjs", ["--help"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("--fixture");
    expect(out.stdout).toContain("--strict");
  });
});

describe("ephemeral-stack", () => {
  it("--dry-run prints the planned lifecycle without writing the temp config", () => {
    const out = run("ephemeral-stack.mjs", ["--dry-run", "--prefix=ci7"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("shiba-ai-coworker-ci7");
    expect(out.stdout).toContain(".wrangler-ephemeral-ci7.jsonc");
    expect(out.stdout).toContain("wrangler deploy --config");
    expect(out.stdout).toContain("wrangler delete");
    expect(existsSync(join(ROOT, "backend", ".wrangler-ephemeral-ci7.jsonc"))).toBe(false);
  });

  it("defaults the prefix to test-<unix-ts>", () => {
    const out = run("ephemeral-stack.mjs", ["--dry-run"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/shiba-ai-coworker-test-\d+/);
  });

  it("documents the honest smoke target: GET / where any status counts (L4)", () => {
    const out = run("ephemeral-stack.mjs", ["--dry-run", "--prefix=ci8"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/workers\.dev\/ /);
    expect(out.stdout).toContain("any HTTP status");
  });

  it("--alchemy --dry-run prints the staged alchemy lifecycle", () => {
    const out = run("ephemeral-stack.mjs", ["--alchemy", "--dry-run", "--prefix=ci7"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("shiba-ai-coworker-ci7");
    expect(out.stdout).toContain("ALCHEMY_STAGE=ci7");
    expect(out.stdout).toContain("alchemy deploy --stage ci7 --yes");
    expect(out.stdout).toContain("alchemy destroy --stage ci7 --yes");
    expect(existsSync(join(ROOT, "backend", ".wrangler-ephemeral-ci7.jsonc"))).toBe(false);
  });

  it("--alchemy honors --keep and rejects bad prefixes", () => {
    const kept = run("ephemeral-stack.mjs", ["--alchemy", "--dry-run", "--keep", "--prefix=ci9"]);
    expect(kept.status).toBe(0);
    expect(kept.stdout).toContain("--keep: teardown skipped");
    const bad = run("ephemeral-stack.mjs", ["--alchemy", "--dry-run", "--prefix=Bad_Prefix"]);
    expect(bad.status).toBe(1);
  });
});

describe("check-alchemy-drift", () => {
  it("alchemy.run.ts mirrors wrangler.jsonc in the real repo files", () => {
    const out = run("check-alchemy-drift.mjs");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("in sync");
  });

  it("exits 1 when wrangler.jsonc gains a binding alchemy.run.ts lacks", () => {
    const out = run("check-alchemy-drift.mjs", [
      `--wrangler=${join(FIXTURES, "drift-wrangler.jsonc")}`,
    ]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("MY_KV");
    expect(out.stderr).toContain("Automations");
  });

  it("exits 1 when alchemy.run.ts drops a var, renames the worker, or adds a non-secret entry", () => {
    const out = run("check-alchemy-drift.mjs", [
      `--alchemy=${join(FIXTURES, "drift-alchemy-run.txt")}`,
    ]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("RUNTIME");
    expect(out.stderr).toContain("ROGUE");
    expect(out.stderr).toContain("renamed-worker");
  });

  it("prints help", () => {
    const out = run("check-alchemy-drift.mjs", ["--help"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("--alchemy");
  });
});

describe("validate-credentials", () => {
  function writeFixture(opts: {
    classes?: string[];
    devVars?: string;
    missingClass?: boolean;
    externalClass?: boolean;
    extraEnvFields?: string;
    extraBindings?: string;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "validate-creds-"));
    const wrangler = join(dir, "wrangler.jsonc");
    const env = join(dir, "env.ts");
    const src = join(dir, "src");
    mkdirSync(src);
    const binding = opts.externalClass
      ? `{ "name": "EXT", "class_name": "FarAway", "script_name": "other-worker" }`
      : `{ "name": "DO_A", "class_name": "${opts.missingClass ? "Missing" : "DoA"}" }`;
    writeFileSync(
      wrangler,
      `{
        "name": "w",
        "vars": { "FOO": "a" },
        "durable_objects": { "bindings": [${binding}] },
        ${opts.extraBindings ?? ""}
      }`,
    );
    writeFileSync(
      env,
      `export interface Env {
        FOO: string;
        DO_A: DurableObjectNamespace;
        EXT: DurableObjectNamespace;
        SLACK_BOT_TOKEN?: string;
        MONKEY?: string;
        ${opts.extraEnvFields ?? ""}
      }`,
    );
    writeFileSync(join(src, "dummy.ts"), "");
    writeFileSync(
      join(src, "classes.ts"),
      (opts.classes ?? ["DoA"]).map((c) => `export class ${c} {}\n`).join(""),
    );
    const args = [`--wrangler=${wrangler}`, `--env=${env}`, `--src=${src}`, "--offline"];
    if (opts.devVars !== undefined) {
      const devVars = join(dir, ".dev.vars");
      writeFileSync(devVars, opts.devVars);
      args.push(`--dev-vars=${devVars}`);
    } else {
      args.push(`--dev-vars=${join(dir, ".dev.vars.absent")}`);
    }
    return args;
  }

  it("exits 0 when bindings, vars, and provisioned secrets all resolve", () => {
    const out = run(
      "validate-credentials.mjs",
      writeFixture({ devVars: "SLACK_BOT_TOKEN=x0xb-redacted\n" }),
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("DoA");
    expect(out.stdout).toContain("SLACK_BOT_TOKEN provisioned");
    expect(out.stdout).not.toContain("x0xb-redacted");
  });

  it("exits 1 when a DO binding class is not exported under src/", () => {
    const out = run("validate-credentials.mjs", writeFixture({ missingClass: true }));
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("Missing");
  });

  it("handles a missing .dev.vars file (wrangler-only secrets)", () => {
    const out = run("validate-credentials.mjs", writeFixture({}));
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("SLACK_BOT_TOKEN not provisioned");
  });

  it("marks script_name DO bindings as external, not missing exports (L5)", () => {
    const out = run("validate-credentials.mjs", writeFixture({ externalClass: true }));
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("external worker");
    expect(out.stdout).toContain("FarAway@other-worker");
  });

  it("does not flag whole-word false positives like MONKEY as secrets (L5)", () => {
    const out = run("validate-credentials.mjs", writeFixture({}));
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("SLACK_BOT_TOKEN not provisioned");
    expect(out.stdout).not.toMatch(/MONKEY.*not provisioned/);
  });

  it("audits bindings and vars inside env.<name> sections", () => {
    const out = run(
      "validate-credentials.mjs",
      writeFixture({
        extraBindings: `"env": { "staging": { "vars": { "STG_MISSING": "x" } } },`,
      }),
    );
    expect(out.status).toBe(1);
    expect(out.stdout).toContain("STG_MISSING");
    expect(out.stdout).toContain("env.staging");
  });
});

describe("scripts/ built-ins-only guard (L6)", () => {
  const NODE_CORE = new Set([
    "assert", "buffer", "child_process", "cluster", "console", "constants", "crypto",
    "dgram", "diagnostics_channel", "dns", "domain", "events", "fs", "http", "http2",
    "https", "inspector", "module", "net", "os", "path", "perf_hooks", "process",
    "punycode", "querystring", "readline", "repl", "stream", "string_decoder", "sys",
    "timers", "tls", "tty", "url", "util", "v8", "vm", "worker_threads", "zlib",
  ]);
  const specAllowed = (spec: string) =>
    spec.startsWith("node:") || NODE_CORE.has(spec.split("/")[0]!);
  const collectSpecifiers = (text: string) =>
    [
      ...text.matchAll(/from\s*["']([^"']+)["']/g),
      ...text.matchAll(/import\s*["']([^"']+)["']/g),
      ...text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]!);

  const SCRIPTS = [
    "check-env-types.mjs",
    "plan-deploy.mjs",
    "ephemeral-stack.mjs",
    "validate-credentials.mjs",
    "check-alchemy-drift.mjs",
  ];

  for (const script of SCRIPTS) {
    it(`${script} imports only node builtins`, () => {
      const text = readFileSync(join(ROOT, "scripts", script), "utf8");
      expect(text).not.toMatch(/\brequire\s*\(/);
      expect(text).not.toMatch(/\bcreateRequire\b/);
      for (const spec of collectSpecifiers(text)) {
        expect(specAllowed(spec)).toBe(true);
      }
    });
  }

  it("the guard itself catches npm imports, require, and createRequire", () => {
    const bad = [
      `import x from"lodash";`,
      `import x from "express";`,
      `const y = require("y");`,
      `import("zod").then(() => {});`,
      `const r = createRequire(import.meta.url);`,
    ];
    for (const line of bad) {
      const specs = collectSpecifiers(line);
      const viaSpecifier = specs.length > 0 && specs.every(specAllowed);
      const viaRequire = /\brequire\s*\(|\bcreateRequire\b/.test(line);
      expect(viaSpecifier && !viaRequire).toBe(false);
    }
  });

  it("the guard allows bare core module specifiers", () => {
    for (const line of [`import fs from "fs";`, `import x from "path/posix";`, `import "node:test";`]) {
      for (const spec of collectSpecifiers(line)) {
        expect(specAllowed(spec)).toBe(true);
      }
    }
  });
});

describe("alchemy adoption guards", () => {
  it("backend/src/ never imports alchemy — the app must stay runtime-agnostic", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    const offenders = walk(join(ROOT, "backend", "src")).filter((f) =>
      /from\s+["']alchemy|import\s*\(\s*["']alchemy|require\s*\(\s*["']alchemy/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
