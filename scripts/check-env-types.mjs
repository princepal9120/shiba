#!/usr/bin/env node
/**
 * Env-type drift check — the plain-wrangler stand-in for Alchemy's InferEnv.
 * Asserts both directions between wrangler.jsonc and the hand-maintained
 * `Env` interface in src/env.ts:
 *
 *  (a) every binding/var declared in wrangler.jsonc (including `env.<name>`
 *      sections) exists as an Env field
 *  (b) every NON-OPTIONAL Env field is declared in wrangler.jsonc
 *      (optional `?:` fields are permitted extras — wrangler secrets or
 *      runtime vars that legitimately live outside the config file)
 *  (c) vars.INSTANCE_TYPE equals every containers[].instance_type
 *
 * Declarations that do not create an `env.X` field — queues.consumers,
 * tail_consumers, placement, routes, crons, migrations — are intentionally
 * not required in Env.
 *
 * Usage: node scripts/check-env-types.mjs [--wrangler=<path>] [--env=<path>]
 * Exit 0 "env bindings in sync"; exit 1 with a drift report.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(`Usage: node scripts/check-env-types.mjs [options]

Options:
  --wrangler=<path>  wrangler config (default: apps/backend/wrangler.jsonc)
  --env=<path>       env types file (default: apps/backend/src/env.ts)
  --help             show this text

Checks both directions: every declared binding/var must be an Env field, and
every non-optional Env field must be declared in wrangler.`);
  process.exit(0);
}

const wranglerPath = resolve(root, arg("wrangler") ?? "apps/backend/wrangler.jsonc");
const envPath = resolve(root, arg("env") ?? "apps/backend/src/env.ts");

// --- JSONC: two string-aware passes — strip comments BEFORE trailing commas,
// so `{a:1, // note\n}` cleans up correctly.
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

// --- Binding/var collection: name -> kind label for every config key that
// produces an `env.X` binding. Anything that does NOT (queues.consumers,
// tail_consumers, placement, routes, crons, migrations) is deliberately absent.
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

function collectDeclaredInto(cfg, declared, scope) {
  const put = (name, kind) => {
    if (typeof name === "string" && name) {
      declared.set(name, scope ? `${kind} [${scope}]` : kind);
    }
  };
  for (const [field, kind, pick] of BINDING_OBJECT_FIELDS) {
    if (cfg[field] && typeof cfg[field] === "object") put(pick(cfg[field]), kind);
  }
  for (const b of cfg.durable_objects?.bindings ?? []) {
    put(b.name, `Durable Object (${b.class_name ?? "?"})`);
  }
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
  collectDeclaredInto(cfg, declared, "");
  // Every `env.<name>` section is an alternate deploy config — check it too.
  for (const [envName, sub] of Object.entries(cfg.env ?? {})) {
    if (sub && typeof sub === "object") collectDeclaredInto(sub, declared, `env.${envName}`);
  }
  return declared;
}

// --- Env interface fields: name -> optional. Depth-tracked so members of
// nested type literals (e.g. `CONFIG: { nested: string }`) are not mistaken
// for Env fields; `readonly` and `interface Env extends X` are supported.
function collectEnvFields(text) {
  const head = text.match(/export\s+interface\s+Env\s*(?:extends\s+[^{]+?)?\s*\{/);
  if (!head || head.index === undefined) throw new Error("no `export interface Env` found");
  const start = head.index + head[0].length - 1;
  let depth = 0;
  let end = -1;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error("unbalanced braces in interface Env");
  const body = text
    .slice(start + 1, end)
    // Block comments (incl. /** doc comments */) go first: their braces and
    // `https://` URLs must not affect member/depth detection.
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const fields = new Map();
  // Members end at `;`. Collect each depth-0 segment so nested type literals
  // (CONFIG: { nested: string }) don't leak members, and several members on
  // one line (interface Env { A: X; B: Y }) are all seen.
  let memberDepth = 0;
  let pending = "";
  const takeMember = (seg) => {
    const m = seg.match(/^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*(\?)?\s*:/);
    if (m) fields.set(m[1], m[2] === "?");
  };
  for (const rawLine of body.split("\n")) {
    const line = rawLine.replace(/\/\/.*$/, ""); // remaining `//` are line comments
    for (const ch of line) {
      if (memberDepth === 0) {
        if (ch === ";") {
          takeMember(pending);
          pending = "";
          continue;
        }
        if (ch === "{") memberDepth++;
        else if (ch === "}") memberDepth--;
        pending += ch;
      } else {
        if (ch === "{") memberDepth++;
        else if (ch === "}") memberDepth--;
      }
    }
  }
  takeMember(pending);
  return fields;
}

let cfg;
try {
  cfg = parseJsonc(readFileSync(wranglerPath, "utf8"));
} catch (err) {
  console.error(`check-env-types: cannot parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

let envFields;
try {
  envFields = collectEnvFields(readFileSync(envPath, "utf8"));
} catch (err) {
  console.error(`check-env-types: cannot parse ${envPath}: ${err.message}`);
  process.exit(1);
}

const declared = collectDeclared(cfg);
const drift = [];

// (a) wrangler -> Env
for (const [name, kind] of declared) {
  if (!envFields.has(name)) {
    drift.push(`drift: ${kind} "${name}" declared in wrangler.jsonc missing from src/env.ts`);
  }
}

// (b) Env -> wrangler (non-optional only)
for (const [name, optional] of envFields) {
  if (!optional && !declared.has(name)) {
    drift.push(`drift: required Env field "${name}" has no binding/var in wrangler.jsonc`);
  }
}

// (c) vars.INSTANCE_TYPE vs containers[].instance_type, per config section
const instanceChecks = [["", cfg], ...Object.entries(cfg.env ?? {}).map(([n, c]) => [`env.${n}`, c])];
for (const [scope, section] of instanceChecks) {
  if (!section || typeof section !== "object") continue;
  const instanceVar = section.vars?.INSTANCE_TYPE;
  if (instanceVar === undefined || !Array.isArray(section.containers)) continue;
  for (const c of section.containers) {
    if (c?.instance_type !== undefined && c.instance_type !== instanceVar) {
      drift.push(
        `drift: vars.INSTANCE_TYPE "${instanceVar}" != containers[].instance_type "${c.instance_type}" (${c.name ?? c.class_name ?? "container"}${scope ? `, ${scope}` : ""})`,
      );
    }
  }
}

if (drift.length > 0) {
  for (const line of drift) console.error(`check-env-types: ${line}`);
  process.exit(1);
}
console.log(
  `check-env-types: env bindings in sync (${declared.size} declared, ${envFields.size} Env fields)`,
);
