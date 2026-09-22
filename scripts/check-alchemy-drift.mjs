#!/usr/bin/env node
/**
 * Alchemy drift check — asserts alchemy.run.ts still mirrors wrangler.jsonc
 * while both deploy paths are committed:
 *
 *  (a) every binding/var wrangler.jsonc declares exists as an alchemy env
 *      entry or Worker prop with the SAME value (vars by literal value, DO
 *      bindings by className, the AI binding, assets config, crons,
 *      compatibility, main, container image/instances)
 *  (b) the worker name resolves to the wrangler `name` (directly or via
 *      the stage-conditional `workerName` const that pins "ai-intern")
 *  (c) vars.INSTANCE_TYPE equals every containers[].instance_type in
 *      wrangler AND the matching Container's instanceType in alchemy.run.ts
 *  (d) every alchemy env entry is either a wrangler-declared name or a
 *      `secret("NAME")` deploy-time secret — alchemy-only bindings are drift
 *
 * Usage: node scripts/check-alchemy-drift.mjs [--wrangler=<path>]
 *          [--alchemy=<path>] [--help]
 * Exit 0 "in sync"; exit 1 with a drift report.
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
  console.log(`Usage: node scripts/check-alchemy-drift.mjs [options]

Options:
  --wrangler=<path>  wrangler config (default: wrangler.jsonc)
  --alchemy=<path>   alchemy stack file (default: alchemy.run.ts)
  --help             show this text

Asserts the alchemy.run.ts stack mirrors wrangler.jsonc: binding names and
kinds, var values, DO class names, container settings, crons, compat, and
the worker name. secret("NAME") env entries are deploy-time secrets and
legitimate extras; any other alchemy-only env name is reported as drift.`);
  process.exit(0);
}

const wranglerPath = resolve(root, arg("wrangler") ?? "wrangler.jsonc");
const alchemyPath = resolve(root, arg("alchemy") ?? "alchemy.run.ts");

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

// --- wrangler declared names: same env-producing set as check-env-types.mjs
// (bindings + vars; queues consumers, placement, routes, crons, migrations
// produce no env.X and are excluded). `containers[]` produces no binding —
// its class_name is a durable_objects.bindings entry — but its settings are
// compared separately below.
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
  for (const [envName, sub] of Object.entries(cfg.env ?? {})) {
    if (sub && typeof sub === "object") collectDeclaredInto(sub, declared, `env.${envName}`);
  }
  return declared;
}

// --- alchemy.run.ts: string-aware TS object-literal member parsing.
// Handles ", ', ` strings with escapes, nested {} [] () depth, and member
// keys that are identifiers or quoted strings. Not a TS parser — it only
// needs to read the Worker props object and its `env` block.
function stripTsComments(text) {
  return stripJsoncComments(text); // same // and /* */ rules
}

// Returns the body of the `{` at openIdx (exclusive) and the index just
// past its matching `}`.
function blockBody(text, openIdx) {
  if (text[openIdx] !== "{") throw new Error("internal: not at `{`");
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      inStr = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { body: text.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  throw new Error("unbalanced braces");
}

// Top-level members of an object literal body: [{key, value (raw text)}].
function splitMembers(body) {
  const members = [];
  let i = 0;
  const n = body.length;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    // Spread member — `...expr` has no key; skip to the next depth-0 comma.
    if (body.startsWith("...", i)) {
      let depth = 0;
      let inStr = null;
      for (; i < n; i++) {
        const c = body[i];
        if (inStr) {
          if (c === "\\") i++;
          else if (c === inStr) inStr = null;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c;
          continue;
        }
        if (c === "{" || c === "[" || c === "(") depth++;
        else if (c === "}" || c === "]" || c === ")") depth--;
        else if (c === "," && depth === 0) break;
      }
      continue;
    }
    const keyMatch = body
      .slice(i)
      .match(/^([A-Za-z_$][\w$]*|"[^"\\]*(?:\\.[^"\\]*)*"|'[^'\\]*(?:\\.[^'\\]*)*')\s*\??\s*:/);
    if (!keyMatch) {
      throw new Error(`cannot parse member near: ${body.slice(i, i + 40)}`);
    }
    const key = keyMatch[1].replace(/^['"]|['"]$/g, "");
    i += keyMatch[0].length;
    const vStart = i;
    let depth = 0;
    let inStr = null;
    for (; i < n; i++) {
      const c = body[i];
      if (inStr) {
        if (c === "\\") i++;
        else if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        inStr = c;
        continue;
      }
      if (c === "{" || c === "[" || c === "(") depth++;
      else if (c === "}" || c === "]" || c === ")") {
        if (depth === 0) break; // end of the object body
        depth--;
      } else if (c === "," && depth === 0) break;
    }
    members.push({ key, value: body.slice(vStart, i).trim() });
    if (body[i] === ",") i++;
  }
  return members;
}

// Members of a nested object-literal value ("{ ... }").
function subMembers(value) {
  const open = value.indexOf("{");
  if (open === -1) return [];
  return splitMembers(blockBody(value, open).body);
}

const membersToMap = (members) => {
  const m = new Map();
  for (const mem of members) m.set(mem.key, mem.value);
  return m;
};

// Decode a literal: "str"/'str'/`str`, number, boolean, or array of literals.
function literal(value) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(value) || /^'(?:[^'\\]|\\.)*'$/.test(value)) {
    try {
      return JSON.parse(value.startsWith("'") ? `"${value.slice(1, -1).replace(/"/g, '\\"')}"` : value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "undefined" || value === "null") return undefined;
  if (value.startsWith("[")) {
    // Array of scalars — tolerate trailing commas.
    const inner = value.slice(1, value.lastIndexOf("]"));
    return inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(literal);
  }
  return { raw: value };
}

// Classify an env member's value expression.
function envKind(value) {
  if (/^Cloudflare\.DurableObject\b/.test(value)) return "durableObject";
  if (/^Cloudflare\.Container\b/.test(value)) return "container";
  if (/^Cloudflare\.Workers\.AI\b/.test(value)) return "ai";
  if (/^secret\(/.test(value)) return "secret";
  if (/^["'`]/.test(value)) return "var";
  return "other";
}

// `className: "X"` inside a DurableObject/Container props object; the env
// key is the binding name, className defaults to it when absent.
const propString = (value, prop) => {
  const m = value.match(new RegExp(`${prop}\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  return m ? m[1] : undefined;
};
const propNumber = (value, prop) => {
  const m = value.match(new RegExp(`${prop}\\s*:\\s*(\\d+)`));
  return m ? Number(m[1]) : undefined;
};

let cfg;
try {
  cfg = parseJsonc(readFileSync(wranglerPath, "utf8"));
} catch (err) {
  console.error(`check-alchemy-drift: cannot parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

let alchemyText;
try {
  alchemyText = stripTsComments(readFileSync(alchemyPath, "utf8"));
} catch (err) {
  console.error(`check-alchemy-drift: cannot read ${alchemyPath}: ${err.message}`);
  process.exit(1);
}

// Locate `Cloudflare.Worker(` → its props object → member map.
let props;
try {
  const callIdx = alchemyText.search(/\bCloudflare\.Worker\s*</) >= 0
    ? alchemyText.search(/\bCloudflare\.Worker\s*(<[^>]*>)?\s*\(/)
    : alchemyText.search(/\bCloudflare\.Worker\s*\(/);
  const openIdx = alchemyText.indexOf("{", callIdx + "Cloudflare.Worker".length);
  props = membersToMap(splitMembers(blockBody(alchemyText, openIdx).body));
} catch (err) {
  console.error(`check-alchemy-drift: cannot parse Worker props in ${alchemyPath}: ${err.message}`);
  process.exit(1);
}

const envValue = props.get("env");
let env;
try {
  env = membersToMap(splitMembers(blockBody(envValue, envValue.indexOf("{")).body));
} catch (err) {
  console.error(`check-alchemy-drift: cannot parse env block in ${alchemyPath}: ${err.message}`);
  process.exit(1);
}

const drift = [];

// (a)(b) worker-level scalar parity
const nameVal = props.get("name");
const nameOk =
  literal(nameVal) === cfg.name ||
  // stage-conditional workerName const — verify it still pins the base name
  (nameVal === "workerName" &&
    new RegExp(`const\\s+workerName[\\s\\S]*?"${cfg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(
      alchemyText,
    ));
if (!nameOk) {
  drift.push(`worker name: wrangler "${cfg.name}" vs alchemy.run.ts ${JSON.stringify(nameVal)}`);
}
if (literal(props.get("main")) !== cfg.main) {
  drift.push(`main: wrangler "${cfg.main}" vs ${JSON.stringify(props.get("main"))}`);
}
const compat = membersToMap(subMembers(props.get("compatibility") ?? ""));
if (literal(compat.get("date")) !== cfg.compatibility_date) {
  drift.push(
    `compatibility date: wrangler "${cfg.compatibility_date}" vs ${JSON.stringify(compat.get("date"))}`,
  );
}
const flags = literal(compat.get("flags"));
if (JSON.stringify(flags ?? []) !== JSON.stringify(cfg.compatibility_flags ?? [])) {
  drift.push(`compatibility flags: wrangler ${JSON.stringify(cfg.compatibility_flags)} vs ${JSON.stringify(flags)}`);
}
const assets = membersToMap(subMembers(props.get("assets") ?? ""));
if (cfg.assets && assets.size === 0) {
  drift.push("assets: wrangler declares an assets block but alchemy.run.ts has none");
} else if (cfg.assets) {
  if (literal(assets.get("directory")) !== cfg.assets.directory) {
    drift.push(
      `assets directory: wrangler "${cfg.assets.directory}" vs ${JSON.stringify(assets.get("directory"))}`,
    );
  }
  if (
    cfg.assets.not_found_handling !== undefined &&
    literal(assets.get("notFoundHandling")) !== cfg.assets.not_found_handling
  ) {
    drift.push(
      `assets notFoundHandling: wrangler "${cfg.assets.not_found_handling}" vs ${JSON.stringify(assets.get("notFoundHandling"))}`,
    );
  }
}
// preview_urls:false ⇔ workersDev.previewsEnabled:false
const workersDev = membersToMap(subMembers(props.get("workersDev") ?? ""));
if (cfg.preview_urls === false && literal(workersDev.get("previewsEnabled")) !== false) {
  drift.push("preview_urls:false in wrangler but workersDev.previewsEnabled is not false");
}
const crons = literal(props.get("crons"));
if (JSON.stringify(crons ?? []) !== JSON.stringify(cfg.triggers?.crons ?? [])) {
  drift.push(`crons: wrangler ${JSON.stringify(cfg.triggers?.crons)} vs ${JSON.stringify(crons)}`);
}

// (a) every wrangler-declared binding/var name must appear in env — except
// the assets binding, which lives in the `assets` Worker prop in alchemy.
const declared = collectDeclared(cfg);
const assetsName = cfg.assets ? (cfg.assets.binding ?? "ASSETS") : null;
for (const [name, kind] of declared) {
  if (assetsName !== null && name === assetsName && props.has("assets")) continue;
  if (!env.has(name)) {
    drift.push(`drift: ${kind} "${name}" declared in wrangler.jsonc missing from alchemy.run.ts env`);
  }
}

// (a) vars: same literal value, as a plain var entry
for (const [key, value] of Object.entries(cfg.vars ?? {})) {
  const v = env.get(key);
  if (v === undefined) continue; // already reported by the sweep
  if (envKind(v) !== "var" || literal(v) !== value) {
    drift.push(`var "${key}": wrangler ${JSON.stringify(value)} vs alchemy ${v}`);
  }
}

// (a) AI binding
if (cfg.ai?.binding) {
  const v = env.get(cfg.ai.binding);
  if (v !== undefined && envKind(v) !== "ai") {
    drift.push(`drift: ai binding "${cfg.ai.binding}" is not Cloudflare.Workers.AI() in alchemy.run.ts`);
  }
}

// (a) DO bindings: env entry is a DurableObject (or the Container decl for
// the container-backed class) whose className equals class_name.
const containerClasses = new Set((cfg.containers ?? []).map((c) => c?.class_name));
for (const b of cfg.durable_objects?.bindings ?? []) {
  const v = env.get(b.name);
  if (v === undefined) continue; // already reported by the sweep
  const kind = envKind(v);
  const wantKind = containerClasses.has(b.class_name) ? "container" : "durableObject";
  if (kind !== wantKind) {
    drift.push(
      `durable object "${b.name}": expected ${wantKind} entry in alchemy.run.ts, found ${kind}`,
    );
    continue;
  }
  const cls = propString(v, "className") ?? b.name;
  if (cls !== b.class_name) {
    drift.push(`durable object "${b.name}": className "${cls}" != wrangler class_name "${b.class_name}"`);
  }
}

// (a)(c) containers: the alchemy Container decl mirrors each entry.
for (const c of cfg.containers ?? []) {
  const v = [...env.entries()].find(
    ([, val]) =>
      envKind(val) === "container" && (propString(val, "className") ?? "") === c.class_name,
  );
  // className defaults to the env key in alchemy — also match by key.
  const byKey = env.get(c.class_name);
  const entry = v ?? (byKey && envKind(byKey) === "container" ? byKey : undefined);
  if (entry === undefined) {
    drift.push(`drift: container class "${c.class_name}" has no Cloudflare.Container env entry`);
    continue;
  }
  if (propString(entry, "name") !== c.name) {
    drift.push(`container "${c.name}": alchemy name "${propString(entry, "name")}" != wrangler name "${c.name}"`);
  }
  if (propString(entry, "dockerfile") !== c.image) {
    drift.push(`container "${c.name}": alchemy dockerfile "${propString(entry, "dockerfile")}" != wrangler image "${c.image}"`);
  }
  if (propString(entry, "instanceType") !== c.instance_type) {
    drift.push(`container "${c.name}": alchemy instanceType "${propString(entry, "instanceType")}" != wrangler instance_type "${c.instance_type}"`);
  }
  if (propNumber(entry, "maxInstances") !== c.max_instances) {
    drift.push(`container "${c.name}": alchemy maxInstances "${propNumber(entry, "maxInstances")}" != wrangler max_instances "${c.max_instances}"`);
  }
  if (cfg.vars?.INSTANCE_TYPE !== undefined && c.instance_type !== cfg.vars.INSTANCE_TYPE) {
    drift.push(`vars.INSTANCE_TYPE "${cfg.vars.INSTANCE_TYPE}" != containers[].instance_type "${c.instance_type}" (${c.name})`);
  }
}

// (d) alchemy-only env entries: fine only as declared secrets.
for (const [key, value] of env) {
  const kind = envKind(value);
  if (kind === "secret") continue;
  if (!declared.has(key) && key !== "ASSETS") {
    drift.push(`drift: alchemy.run.ts env "${key}" has no wrangler.jsonc counterpart (only secret(...) entries may be extra)`);
  }
}

if (drift.length > 0) {
  for (const line of drift) console.error(`check-alchemy-drift: ${line}`);
  process.exit(1);
}
console.log(
  `check-alchemy-drift: alchemy.run.ts in sync with wrangler.jsonc (${declared.size} declared, ${env.size} env entries)`,
);
