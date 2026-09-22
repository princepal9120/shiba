#!/usr/bin/env node
/**
 * Env-type drift check — the plain-wrangler stand-in for Alchemy's InferEnv.
 * Asserts both directions between wrangler.jsonc and the hand-maintained
 * `Env` interface in src/env.ts:
 *
 *  (a) every binding/var declared in wrangler.jsonc exists as an Env field
 *  (b) every NON-OPTIONAL Env field is declared in wrangler.jsonc
 *      (optional `?:` fields are permitted extras — wrangler secrets or
 *      runtime vars that legitimately live outside the config file)
 *  (c) vars.INSTANCE_TYPE equals every containers[].instance_type
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
  --wrangler=<path>  wrangler config (default: wrangler.jsonc)
  --env=<path>       env types file (default: src/env.ts)
  --help             show this text

Checks both directions: every declared binding/var must be an Env field, and
every non-optional Env field must be declared in wrangler.`);
  process.exit(0);
}

const wranglerPath = resolve(root, arg("wrangler") ?? "wrangler.jsonc");
const envPath = resolve(root, arg("env") ?? "src/env.ts");

// --- JSONC: strip // and /* */ comments and trailing commas, skipping strings.
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
        i++; // drop trailing comma
        continue;
      }
    }
    out += c;
    i++;
  }
  return JSON.parse(out);
}

// --- Binding/var collection: name -> kind for every declared env surface.
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
  put(cfg.ai?.binding, "ai");
  for (const b of cfg.durable_objects?.bindings ?? []) put(b.name, `durable_object(${b.class_name ?? "?"})`);
  if (cfg.assets) put("ASSETS", "assets");
  for (const field of BINDING_ARRAY_FIELDS) {
    for (const b of cfg[field] ?? []) put(b.binding ?? b.name, field);
  }
  for (const p of cfg.queues?.producers ?? []) put(p.binding, "queue_producer");
  for (const b of cfg.unsafe?.bindings ?? []) put(b.name, `unsafe(${b.type ?? "?"})`);
  put(cfg.browser?.binding, "browser");
  put(cfg.images?.binding, "images");
  for (const key of Object.keys(cfg.vars ?? {})) put(key, "var");
  return declared;
}

// --- Env interface fields: name -> optional.
function collectEnvFields(text) {
  const head = text.match(/export\s+interface\s+Env\s*\{/);
  if (!head || head.index === undefined) throw new Error("no `export interface Env` found");
  let depth = 0;
  let start = head.index + head[0].length - 1;
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
  const body = text.slice(start + 1, end);
  const fields = new Map();
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*:/);
    if (m) fields.set(m[1], m[2] === "?");
  }
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

// (c) vars.INSTANCE_TYPE vs containers[].instance_type
const instanceVar = cfg.vars?.INSTANCE_TYPE;
if (instanceVar !== undefined && Array.isArray(cfg.containers)) {
  for (const c of cfg.containers) {
    if (c?.instance_type !== undefined && c.instance_type !== instanceVar) {
      drift.push(
        `drift: vars.INSTANCE_TYPE "${instanceVar}" != containers[].instance_type "${c.instance_type}" (${c.name ?? c.class_name ?? "container"})`,
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
