#!/usr/bin/env node
/**
 * Deploy plan — the plain-wrangler stand-in for `alchemy plan`. Runs
 * `wrangler deploy --dry-run` (or parses a saved capture via --fixture),
 * summarizes the resources the deploy would touch, and compares them —
 * name AND resource kind — against the bindings/vars expected from
 * wrangler.jsonc (including `env.<name>` sections).
 *
 * Safety net, not a blocker: unexpected diffs print warnings but exit 0 by
 * default; pass --strict to fail on any unexpected/missing/changed item. A
 * wrangler invocation failure is a real failure and exits 1.
 *
 * Note: --dry-run exits before the "Deployed <name> triggers" block, so
 * routes/crons never appear in plan output — only bindings and containers.
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
  --fixture=<file>   parse a saved wrangler-deploy-dry-run output file
                     instead of invoking wrangler (unit-testable, offline)
  --strict           exit 1 when the plan differs from wrangler.jsonc
  --wrangler=<path>  wrangler config for the expectation set
                     (default: backend/wrangler.jsonc)
  --outdir=<dir>     dry-run output dir (default: ./.wrangler/deploy-preview)
  --help             show this text

Prints "This deploy will: ..." — bound resources, vars, containers — then
warns about anything wrangler.jsonc expects that the plan dropped, added,
or re-kinded. Default exit 0 with warnings; a wrangler failure exits 1.`);
  process.exit(0);
}

const wranglerPath = resolve(root, arg("wrangler") ?? "backend/wrangler.jsonc");
const fixturePath = arg("fixture");
const strict = flag("strict");

// --- JSONC: two string-aware passes — strip comments BEFORE trailing commas.
function stripJsoncComments(text) {
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
    out += c;
    i++;
  }
  return out;
}

function stripTrailingCommas(text) {
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
  return out;
}

const parseJsonc = (text) => JSON.parse(stripTrailingCommas(stripJsoncComments(text)));

// --- Expected bindings: name -> canonical kind label matching wrangler's
// bindings-table "Resource" column. Anything not producing an `env.X` field
// (queues.consumers, tail_consumers, placement, routes, crons) is excluded.
const BINDING_ARRAY_FIELDS = [
  ["kv_namespaces", "KV Namespace", (b) => b.binding],
  ["r2_buckets", "R2 Bucket", (b) => b.binding],
  ["d1_databases", "D1 Database", (b) => b.binding],
  ["services", "Service", (b) => b.binding],
  ["analytics_engine_datasets", "Analytics Engine Dataset", (b) => b.binding],
  ["dispatch_namespaces", "Dispatch Namespace", (b) => b.binding],
  ["hyperdrive", "Hyperdrive", (b) => b.binding],
  ["vectorize", "Vectorize Index", (b) => b.binding],
  ["secrets_store_secrets", "Secrets Store Secret", (b) => b.binding],
  ["workflows", "Workflow", (b) => b.binding ?? b.name],
  ["ratelimits", "Rate Limit", (b) => b.name],
  ["send_email", "Send Email", (b) => b.name ?? b.binding],
  ["pipelines", "Pipeline", (b) => b.binding],
  ["mtls_certificates", "mTLS Certificate", (b) => b.binding],
];
const BINDING_OBJECT_FIELDS = [
  ["ai", "AI", (o) => o.binding],
  ["version_metadata", "Version Metadata", (o) => o.binding],
  ["media", "Media", (o) => o.binding],
  ["browser", "Browser", (o) => o.binding],
  ["images", "Images", (o) => o.binding],
];
const BINDING_MAP_FIELDS = [
  ["wasm_modules", "WASM Module"],
  ["data_blobs", "Data Blob"],
  ["text_blobs", "Text Blob"],
];

function collectDeclaredInto(cfg, declared) {
  const put = (name, kind) => {
    if (typeof name === "string" && name) declared.set(name, kind);
  };
  for (const [field, kind, pick] of BINDING_OBJECT_FIELDS) {
    if (cfg[field] && typeof cfg[field] === "object") put(pick(cfg[field]), kind);
  }
  for (const b of cfg.durable_objects?.bindings ?? []) put(b.name, "Durable Object");
  // `assets.binding` renames the implicit ASSETS Fetcher.
  if (cfg.assets) put(cfg.assets.binding ?? "ASSETS", "Static Assets");
  for (const [field, kind, pick] of BINDING_ARRAY_FIELDS) {
    for (const b of cfg[field] ?? []) put(pick(b) ?? b.binding ?? b.name, kind);
  }
  for (const p of cfg.queues?.producers ?? []) put(p.binding ?? p.name, "Queue Producer");
  for (const b of cfg.logfwdr?.bindings ?? []) put(b.name, "Logfwdr");
  for (const b of cfg.unsafe?.bindings ?? []) put(b.name, `Unsafe (${b.type ?? "?"})`);
  for (const [field, kind] of BINDING_MAP_FIELDS) {
    for (const k of Object.keys(cfg[field] ?? {})) put(k, kind);
  }
  for (const key of Object.keys(cfg.vars ?? {})) put(key, "Environment Variable");
}

function collectDeclared(cfg) {
  const declared = new Map();
  collectDeclaredInto(cfg, declared);
  for (const sub of Object.values(cfg.env ?? {})) {
    if (sub && typeof sub === "object") collectDeclaredInto(sub, declared);
  }
  return declared;
}

// --- Parse wrangler dry-run output.
// Real shape (wrangler 4.x):
//   Your Worker has access to the following bindings:
//   Binding                          Resource
//   env.CodingOrchestrator (CodingOrchestrator)   Durable Object
//   env.GATEWAY_ID ("default")       Environment Variable
//   The following containers are available:
//   - shiba-ai-coworker-sandbox (/repo/Dockerfile)
// --dry-run exits before the "Deployed <name> triggers" section, so routes
// and crons can never appear here.
function parsePlan(output) {
  const lines = output.split("\n").map((l) => l.replace(/\[[0-9;]*m/g, ""));
  const seen = new Map(); // env name -> resource column
  const containers = [];
  let hasAssets = false;
  let inContainers = false;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^The following containers are available:/.test(line.trim())) {
      inContainers = true;
      continue;
    }
    if (line.trim() === "" || line.startsWith("--dry-run")) {
      inContainers = false;
      continue;
    }
    if (/assets directory/.test(line)) hasAssets = true;
    if (inContainers) {
      const m = line.trim().match(/^-\s+(\S+)/);
      if (m) containers.push(m[1]);
      continue;
    }
    const m = line.match(/^\s*env\.([A-Za-z_$][\w$]*)(?:\s+\(([^)]*)\))?\s{2,}(\S.*?)\s*$/);
    if (m) seen.set(m[1], (m[3] ?? "").trim());
  }
  return { seen, containers, hasAssets };
}

// Wrangler's Resource column vs our canonical kinds — normalized for compare.
const normKind = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

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
const summarized = new Set(plan.seen.keys());
for (const [name, resource] of plan.seen) {
  lines.push(`  bind ${name} (${resource})`);
}
for (const [name, kind] of expected) {
  if (!summarized.has(name) && kind === "Static Assets" && plan.hasAssets) {
    lines.push(`  bind ${name} (Static Assets)`);
  }
}
for (const c of plan.containers) lines.push(`  deploy container ${c}`);
if (plan.seen.size === 0 && plan.containers.length === 0) {
  lines.push("  (no bindings parsed from wrangler output)");
}
console.log(lines.join("\n"));

// --- Compare expectation vs plan: name AND kind.
const warnings = [];
for (const [name, kind] of expected) {
  const seen = plan.seen.get(name);
  if (seen === undefined) {
    if (kind === "Static Assets" && plan.hasAssets) continue;
    warnings.push(`missing: ${kind} "${name}" is declared in wrangler.jsonc but absent from the deploy plan`);
    continue;
  }
  if (normKind(seen) !== normKind(kind)) {
    warnings.push(`changed: "${name}" is ${kind} in wrangler.jsonc but "${seen}" in the deploy plan`);
  }
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
