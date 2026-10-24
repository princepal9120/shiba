import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..", "..");
const FIXTURES = join(ROOT, "apps", "backend", "test", "fixtures");

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
    expect(existsSync(join(ROOT, "apps", "backend", ".wrangler-ephemeral-ci7.jsonc"))).toBe(false);
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
    expect(existsSync(join(ROOT, "apps", "backend", ".wrangler-ephemeral-ci7.jsonc"))).toBe(false);
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

describe("shiba-dev-lib", () => {
  it("merge dev vars mints only missing AUTO_GENERATE keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "shiba-dev-"));
    const example = join(dir, ".dev.vars.example");
    writeFileSync(example, "# GITHUB_TOKEN=\nINTERNAL_SIGNING_KEY=\n");
    const devVars = join(dir, ".dev.vars");
    writeFileSync(devVars, "GITHUB_TOKEN=keep-me\nINTERNAL_SIGNING_KEY=existing\n", { mode: 0o600 });
    const lib = join(ROOT, "scripts", "shiba-dev-lib.mjs");
    const out = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { ensureDevVars, parseDevVars } from ${JSON.stringify(lib)};
import { readFileSync } from "node:fs";
let n = 0;
const { appended } = ensureDevVars({
  root: ${JSON.stringify(dir)},
  exampleRel: ".dev.vars.example",
  devVarsRel: ".dev.vars",
  generate: () => "gen-" + (++n),
});
const parsed = parseDevVars(readFileSync(${JSON.stringify(devVars)}, "utf8"));
console.log(JSON.stringify({
  appended,
  github: parsed.get("GITHUB_TOKEN"),
  internal: parsed.get("INTERNAL_SIGNING_KEY"),
  pairing: parsed.get("PAIRING_SECRET"),
}));`,
      ],
      { encoding: "utf8" },
    );
    expect(out.status).toBe(0);
    const body = JSON.parse(out.stdout.trim());
    expect(body.appended).toContain("PAIRING_SECRET");
    expect(body.appended).not.toContain("INTERNAL_SIGNING_KEY");
    expect(body.github).toBe("keep-me");
    expect(body.internal).toBe("existing");
    expect(body.pairing).toBe("gen-1");
  });

  it("dry-run plan lists migrate, image build, and wrangler dev", () => {
    const lib = join(ROOT, "scripts", "shiba-dev-lib.mjs");
    const out = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { formatDryRun, planDevSteps } from ${JSON.stringify(lib)};
const text = formatDryRun(planDevSteps({ skipInstall: true, skipBuild: true }));
console.log(text);`,
      ],
      { encoding: "utf8", cwd: ROOT },
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("d1-migrate");
    expect(out.stdout).toContain("container-build");
    expect(out.stdout).toContain("wrangler-dev");
    expect(out.stdout).toContain("8788/app/");
    const cli = run("shiba.mjs", ["dev", "--dry-run", "--skip-install", "--skip-build"]);
    expect(cli.status).toBe(0);
    expect(cli.stdout).toContain("dry run");
    expect(cli.stdout).toContain("GITHUB_TOKEN");
  });

  it("disables containers without dropping the migrate and dev steps", () => {
    const lib = join(ROOT, "scripts", "shiba-dev-lib.mjs");
    const out = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { formatDryRun, planDevSteps } from ${JSON.stringify(lib)};
const text = formatDryRun(planDevSteps({ skipInstall: true, skipBuild: true, containers: false }));
if (text.includes("container-build")) process.exit(2);
if (!text.includes("--enable-containers=false")) process.exit(3);
if (!text.includes("d1-migrate") || !text.includes("wrangler-dev")) process.exit(4);
console.log("ok");`,
      ],
      { encoding: "utf8", cwd: ROOT },
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("ok");
  });
});

describe("first-run setup wizard", () => {
  it("walks a fresh clone with no dead ends and keeps tokens out of the record", () => {
    const lib = join(ROOT, "scripts", "shiba-setup-lib.mjs");
    const out = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitSetup, readSetupFile, setupPath, walkthroughFreshClone } from ${JSON.stringify(lib)};
const walked = walkthroughFreshClone();
if (!walked.ok || !walked.log.includes("result: no dead ends")) throw new Error(walked.log);
const root = mkdtempSync(join(tmpdir(), "shiba-setup-"));
const token = "local-token-value";
const committed = commitSetup(root, {
  github: { mode: "token", token },
  model: { mode: "byom", baseUrl: "https://models.example/v1", credentialRef: "alias" },
  sandbox: { provider: "cloudflare" },
  testRepo: { url: "https://github.com/octocat/hello" },
}, { dockerOk: false, devVarKeys: new Set() });
const text = readFileSync(setupPath(root), "utf8");
if (text.includes(token)) throw new Error("setup.json stored a token");
if (committed.patch.GITHUB_TOKEN !== token) throw new Error("patch dropped the token");
if (committed.record.containers !== false) throw new Error("docker-down still wants containers");
const saved = readSetupFile(setupPath(root));
if (saved.answers.github.token) throw new Error("token field survived");
if (saved.answers.testRepo.url !== "https://github.com/octocat/hello") throw new Error("test repo dropped");
console.log(walked.log);`,
      ],
      { encoding: "utf8", cwd: ROOT },
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("result: no dead ends");
    expect(out.stdout).toContain("containers: disabled");
    expect(out.stderr).toBe("");
  });

  it("setup --help and dev --dry-run do not prompt", { timeout: 20_000 }, () => {
    const help = run("shiba.mjs", ["setup", "--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("setup fix");
    const dry = run("shiba.mjs", ["setup", "--dry-run"]);
    expect(dry.status).toBe(0);
    expect(dry.stdout).toContain("nothing written");
    expect(dry.stdout).toContain("guide.github");
  });
});

describe("check-dev-vars-example", () => {
  it("exits 0 when the repo example matches env.ts and .env.schema", () => {
    const out = run("check-dev-vars-example.mjs");
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("documents");
  });

  it("exits 1 when a required secret is missing from the example file", () => {
    const dir = mkdtempSync(join(tmpdir(), "dev-vars-check-"));
    const example = join(dir, ".dev.vars.example");
    writeFileSync(example, "# GITHUB_TOKEN=\n");
    const out = run("check-dev-vars-example.mjs", [`--example=${example}`]);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("missing");
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
    "check-dev-vars-example.mjs",
    "plan-deploy.mjs",
    "ephemeral-stack.mjs",
    "validate-credentials.mjs",
    "check-alchemy-drift.mjs",
    "shiba-dev-lib.mjs",
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
    const offenders = walk(join(ROOT, "apps", "backend", "src")).filter((f) =>
      /from\s+["']alchemy|import\s*\(\s*["']alchemy|require\s*\(\s*["']alchemy/.test(
        readFileSync(f, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
