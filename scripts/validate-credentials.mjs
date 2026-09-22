#!/usr/bin/env node
/**
 * Credential & binding hygiene check — the plain-wrangler stand-in for
 * Alchemy's type-checked bindings/IAM. Reports, never mutates, and never
 * prints secret values (only binding and variable NAMES).
 *
 *  (a) every Durable Object class named in wrangler.jsonc is exported
 *      somewhere under src/ (`export class <name>`)
 *  (b) every wrangler.jsonc `vars` key exists as a field on `Env`
 *  (c) secret-bearing OPTIONAL Env fields (name has SECRET|TOKEN|KEY) are
 *      provisioned: present in .dev.vars or listed by `wrangler secret list`
 *
 * Exit 1 when any REQUIRED item ((a) or (b)) is missing. Secrets are
 * optional wiring — missing ones print warnings but do not fail the run.
 *
 * Usage: node scripts/validate-credentials.mjs [--wrangler=<path>]
 *          [--env=<path>] [--dev-vars=<path>] [--src=<dir>] [--offline]
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

if (flag("help") || flag("h")) {
  console.log(`Usage: node scripts/validate-credentials.mjs [options]

Options:
  --wrangler=<path>   wrangler config (default: wrangler.jsonc)
  --env=<path>        env types file (default: src/env.ts)
  --dev-vars=<path>   .dev.vars path (default: .dev.vars; absent = ok)
  --src=<dir>         source dir for export-class checks (default: src)
  --offline           skip wrangler secret list (no network/auth)
  --help              show this text

Marks ✅ present, ⚠ missing-optional, ❌ missing-required. Exit 1 on ❌.`);
  process.exit(0);
}

const wranglerPath = resolve(root, arg("wrangler") ?? "wrangler.jsonc");
const envPath = resolve(root, arg("env") ?? "src/env.ts");
const devVarsPath = resolve(root, arg("dev-vars") ?? ".dev.vars");
const srcDir = resolve(root, arg("src") ?? "src");
const offline = flag("offline");

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

function collectEnvFields(text) {
  const head = text.match(/export\s+interface\s+Env\s*\{/);
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
  const fields = new Map(); // name -> optional
  for (const line of text.slice(start + 1, end).split("\n")) {
    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*(\?)?\s*:/);
    if (m) fields.set(m[1], m[2] === "?");
  }
  return fields;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry)) yield p;
  }
}

function collectExportedClasses(dir) {
  const names = new Set();
  if (!existsSync(dir)) return names;
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

// .dev.vars: KEY=VALUE lines — record key NAMES only, never values.
function collectDevVarKeys(path) {
  const keys = new Set();
  if (!existsSync(path)) return { keys, present: false };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_$][\w$]*)\s*=/);
    if (m && !line.trim().startsWith("#")) keys.add(m[1]);
  }
  return { keys, present: true };
}

function listWranglerSecrets() {
  const res = spawnSync("npx", ["wrangler", "secret", "list"], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
  });
  if (res.error || res.status !== 0) return null; // unauthenticated/unavailable
  const names = new Set();
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  // JSON array [{"name":"X",...}] shape, plus a tolerant NAME-ish fallback.
  for (const m of out.matchAll(/"name"\s*:\s*"([^"]+)"/g)) names.add(m[1]);
  return names;
}

let cfg;
try {
  cfg = parseJsonc(readFileSync(wranglerPath, "utf8"));
} catch (err) {
  console.error(`validate-credentials: cannot parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}
let envFields;
try {
  envFields = collectEnvFields(readFileSync(envPath, "utf8"));
} catch (err) {
  console.error(`validate-credentials: cannot parse ${envPath}: ${err.message}`);
  process.exit(1);
}

const results = [];
let requiredMissing = 0;
const ok = (msg) => results.push(`  ✅ ${msg}`);
const warn = (msg, hint) => results.push(`  ⚠ ${msg}${hint ? ` — fix: ${hint}` : ""}`);
const fail = (msg, hint) => {
  requiredMissing++;
  results.push(`  ❌ ${msg}${hint ? ` — fix: ${hint}` : ""}`);
};

// (a) Durable Object bindings -> exported classes under src/
const classes = collectExportedClasses(srcDir);
const doBindings = cfg.durable_objects?.bindings ?? [];
results.push("durable object bindings:");
for (const b of doBindings) {
  const cls = b.class_name ?? b.name;
  if (classes.has(cls)) ok(`${b.name} -> class ${cls} exported under ${srcDir === resolve(root, "src") ? "src" : srcDir}/`);
  else fail(`binding ${b.name} references class ${cls}, not exported under src/`, `add \`export class ${cls}\``);
}

// (b) vars -> Env fields
const varsKeys = Object.keys(cfg.vars ?? {});
results.push("wrangler vars:");
for (const key of varsKeys) {
  if (envFields.has(key)) ok(`var ${key} has Env field${envFields.get(key) ? " (optional)" : ""}`);
  else fail(`var ${key} missing from Env interface`, "add it to src/env.ts");
}

// (c) secret-bearing optional Env fields -> .dev.vars or `wrangler secret`
const secretNames = [...envFields.keys()].filter(
  (name) => envFields.get(name) && /SECRET|TOKEN|KEY/.test(name),
);
const { keys: devVarKeys, present: devVarsPresent } = collectDevVarKeys(devVarsPath);
let remoteSecrets = null;
if (!offline) remoteSecrets = listWranglerSecrets();

results.push("secrets (optional Env fields — unset disables the feature):");
if (!devVarsPresent) {
  results.push(`  (no ${devVarsPath === resolve(root, ".dev.vars") ? ".dev.vars" : devVarsPath} file — checking wrangler only)`);
}
if (remoteSecrets === null) {
  results.push(
    offline
      ? "  (--offline: `wrangler secret list` skipped)"
      : "  (`wrangler secret list` unavailable — unauthenticated or offline; showing .dev.vars only)",
  );
}
for (const name of secretNames) {
  const inLocal = devVarKeys.has(name);
  const inRemote = remoteSecrets?.has(name) ?? false;
  if (inLocal || inRemote) {
    const where = [inLocal && ".dev.vars", inRemote && "wrangler secret"].filter(Boolean).join(" + ");
    ok(`${name} provisioned (${where})`);
  } else {
    warn(`${name} not provisioned`, `\`wrangler secret put ${name}\` or add to .dev.vars`);
  }
}

console.log("validate-credentials:");
console.log(results.join("\n"));
if (requiredMissing > 0) {
  console.error(`validate-credentials: ${requiredMissing} required item(s) missing`);
  process.exit(1);
}
console.log("validate-credentials: required bindings and vars OK");
