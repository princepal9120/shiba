#!/usr/bin/env node
/**
 * Deploy plan — the plain-wrangler stand-in for `alchemy plan`. Runs
 * `wrangler deploy --dry-run` (or parses a saved capture via --fixture),
 * summarizes the resources the deploy would touch, and compares them
 * against the bindings/vars expected from wrangler.jsonc.
 *
 * Safety net, not a blocker: unexpected diffs print warnings but exit 0 by
 * default; pass --strict to fail on any unexpected/missing item. A wrangler
 * invocation failure is a real failure and exits 1.
 *
 * Usage: node scripts/plan-deploy.mjs [--fixture=<file>] [--strict]
 *          [--wrangler=<path>] [--outdir=<dir>] [--help]
 */
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("help") || flag("h")) {
  console.log(`Usage: node scripts/plan-deploy.mjs [options]

Options:
  --fixture=<file>   parse a saved \`wrangler deploy --dry-run\` output file
                     instead of invoking wrangler (unit-testable, offline)
  --strict           exit 1 when the plan differs from wrangler.jsonc
  --wrangler=<path>  wrangler config for the expectation set
                     (default: wrangler.jsonc)
  --outdir=<dir>     dry-run output dir (default: ./.wrangler/deploy-preview)
  --help             show this text

Prints "This deploy will: ..." — bound resources, vars, routes, containers —
then warns about anything wrangler.jsonc expects that the plan dropped or
added. Default exit 0 with warnings; a wrangler failure exits 1.`);
  process.exit(0);
}

const wranglerPath = resolve(root, arg("wrangler") ?? "wrangler.jsonc");
const fixturePath = arg("fixture");
const strict = flag("strict");

// --- JSONC parse (comments + trailing commas, string-aware).
function parseJsonc(text) {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") {
        if (n !== undefined) out += n;
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

const BINDING_ARRAY_FIELDS = [
  "kv_namespaces",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "hyperdrive",
  "services",
  "analytics_engine_datasets",
  "dispatch_namespaces",
  "mtls_certificates",
  "pipelines",
  "workflows",
  "secrets_store_secrets",
  "send_email",
];

function collectDeclared(cfg) {
  const declared = new Map(); // name -> kind
  const put = (name, kind) => {
    if (typeof name === "string" && name) declared.set(name, kind);
  };
  put(cfg.ai?.binding, "AI");
  for (const b of cfg.durable_objects?.bindings ?? []) put(b.name, "Durable Object");
  // `assets` does not appear in wrangler's binding table; the dry run instead
  // logs "Read N files from the assets directory", handled separately below.
  if (cfg.assets) put("ASSETS", "Static Assets");
  for (const field of BINDING_ARRAY_FIELDS) {
    for (const b of cfg[field] ?? []) put(b.binding ?? b.name, field);
  }
  for (const p of cfg.queues?.producers ?? []) put(p.binding, "Queue Producer");
  for (const b of cfg.unsafe?.bindings ?? []) put(b.name, `unsafe(${b.type ?? "?"})`);
  put(cfg.browser?.binding, "Browser");
  put(cfg.images?.binding, "Images");
  for (const key of Object.keys(cfg.vars ?? {})) put(key, "Environment Variable");
  return declared;
}

// --- Parse wrangler dry-run output.
// Real shape (wrangler 4.x):
//   Your Worker has access to the following bindings:
//   Binding                          Resource
//   env.CodingOrchestrator (CodingOrchestrator)   Durable Object
//   env.GATEWAY_ID ("default")       Environment Variable
// plus "The following containers are available:" and optional route blocks.
function parsePlan(output) {
  const lines = output.split("\n").map((l) => l.replace(/\[[0-9;]*m/g, ""));
  const seen = new Map(); // env name -> resource column
  const containers = [];
  const routes = [];
  const extras = [];
  let hasAssets = false;
  let inContainers = false;
  let inRoutes = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^The following containers are available:/.test(line.trim())) {
      inContainers = true;
      inRoutes = false;
      continue;
    }
    if (/^(Routes?|Custom Domains?|Triggers)\b.*:/.test(line.trim())) {
      inRoutes = true;
      inContainers = false;
      continue;
    }
    if (line.trim() === "" || line.startsWith("--dry-run")) {
      inContainers = false;
      inRoutes = false;
      continue;
    }
    if (/assets directory/.test(line)) hasAssets = true;

    if (inContainers) {
      const m = line.trim().match(/^-\s+(\S+)/);
      if (m) containers.push(m[1]);
      continue;
    }
    if (inRoutes) {
      const m = line.trim().match(/^-\s+(\S+)/);
      if (m) routes.push(m[1]);
      continue;
    }

    const m = line.match(/^\s*env\.([A-Za-z_$][\w$]*)(?:\s+\(([^)]*)\))?\s{2,}(\S.*?)\s*$/);
    if (m) {
      seen.set(m[1], (m[3] ?? "").trim());
      continue;
    }
    const schedule = line.match(/^\s*-\s+(cron|schedule)\s*[:=]?\s*(.+)$/i);
    if (schedule) extras.push(`cron ${schedule[2].trim()}`);
  }
  return { seen, containers, routes, extras, hasAssets };
}

let planOutput;
if (fixturePath) {
  const file = resolve(root, fixturePath);
  try {
    planOutput = readFileSync(file, "utf8");
  } catch {
    console.error(`plan-deploy: cannot read fixture ${file}`);
    process.exit(1);
  }
} else {
  const outdir = arg("outdir") ?? "./.wrangler/deploy-preview";
  const cmd = ["wrangler", "deploy", "--dry-run", `--outdir=${outdir}`];
  const res = spawnSync("npx", cmd, { cwd: root, encoding: "utf8", timeout: 600_000 });
  if (res.error || res.status !== 0) {
    console.error("plan-deploy: `npx wrangler deploy --dry-run` failed");
    const tail = `${res.stdout ?? ""}\n${res.stderr ?? ""}`.trim().split("\n").slice(-25);
    for (const l of tail) console.error(`  ${l}`);
    process.exit(1);
  }
  planOutput = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
}

let expected;
try {
  expected = collectDeclared(parseJsonc(readFileSync(wranglerPath, "utf8")));
} catch (err) {
  console.error(`plan-deploy: cannot parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

const plan = parsePlan(planOutput);

// --- Human-readable summary.
const lines = ["This deploy will:"];
for (const [name, resource] of plan.seen) {
  lines.push(`  bind ${name} (${resource})`);
}
for (const [name] of expected) {
  if (name === "ASSETS" && plan.hasAssets && !plan.seen.has(name)) {
    lines.push("  bind ASSETS (Static Assets)");
  }
}
for (const c of plan.containers) lines.push(`  deploy container ${c}`);
for (const r of plan.routes) lines.push(`  route ${r}`);
for (const x of plan.extras) lines.push(`  trigger ${x}`);
if (plan.seen.size === 0 && plan.containers.length === 0) {
  lines.push("  (no bindings parsed from wrangler output)");
}
console.log(lines.join("\n"));

// --- Compare expectation vs plan.
const warnings = [];
for (const [name, kind] of expected) {
  if (plan.seen.has(name)) continue;
  if (name === "ASSETS" && plan.hasAssets) continue;
  warnings.push(`missing: ${kind} "${name}" is declared in wrangler.jsonc but absent from the deploy plan`);
}
for (const [name, resource] of plan.seen) {
  if (!expected.has(name)) {
    warnings.push(`unexpected: plan shows "${name}" (${resource}) not declared in wrangler.jsonc`);
  }
}

for (const w of warnings) console.error(`plan-deploy: WARN ${w}`);
if (warnings.length > 0) {
  console.error(
    `plan-deploy: ${warnings.length} difference(s)${strict ? " (strict)" : " — non-blocking; pass --strict to fail"}`,
  );
  process.exit(strict ? 1 : 0);
}
console.log(`plan-deploy: plan matches wrangler.jsonc (${expected.size} declared)`);
