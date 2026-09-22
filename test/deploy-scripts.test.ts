import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const FIXTURES = join(ROOT, "test", "fixtures");

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
    expect(out.stdout).toContain("ai-intern-ci7");
    expect(out.stdout).toContain(".wrangler-ephemeral-ci7.jsonc");
    expect(out.stdout).toContain("wrangler deploy --config");
    expect(out.stdout).toContain("wrangler delete");
    expect(existsSync(join(ROOT, ".wrangler-ephemeral-ci7.jsonc"))).toBe(false);
  });

  it("defaults the prefix to test-<unix-ts>", () => {
    const out = run("ephemeral-stack.mjs", ["--dry-run"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/ai-intern-test-\d+/);
  });
});

describe("validate-credentials", () => {
  function writeFixture(opts: {
    classes?: string[];
    devVars?: string;
    missingClass?: boolean;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "validate-creds-"));
    const wrangler = join(dir, "wrangler.jsonc");
    const env = join(dir, "env.ts");
    const src = join(dir, "src");
    mkdirSync(src);
    const className = opts.missingClass ? "Missing" : "DoA";
    writeFileSync(
      wrangler,
      `{
        "name": "w",
        "vars": { "FOO": "a" },
        "durable_objects": { "bindings": [{ "name": "DO_A", "class_name": "${className}" }] },
      }`,
    );
    writeFileSync(
      env,
      `export interface Env {
        FOO: string;
        DO_A: DurableObjectNamespace;
        SLACK_BOT_TOKEN?: string;
      }`,
    );
    writeFileSync(join(src, "dummy.ts"), "");
    const srcFile = join(src, "classes.ts");
    writeFileSync(srcFile, (opts.classes ?? ["DoA"]).map((c) => `export class ${c} {}\n`).join(""));
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
});

describe("scripts/ built-ins-only guard", () => {
  const SCRIPTS = [
    "check-env-types.mjs",
    "plan-deploy.mjs",
    "ephemeral-stack.mjs",
    "validate-credentials.mjs",
  ];

  for (const script of SCRIPTS) {
    it(`${script} imports only node: builtins`, () => {
      const text = readFileSync(join(ROOT, "scripts", script), "utf8");
      expect(text).not.toMatch(/require\s*\(/);
      const specifiers = [
        ...text.matchAll(/from\s+["']([^"']+)["']/g),
        ...text.matchAll(/import\s+["']([^"']+)["']/g),
        ...text.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
      ].map((m) => m[1]);
      for (const spec of specifiers) {
        expect(spec?.startsWith("node:")).toBe(true);
      }
    });
  }
});
