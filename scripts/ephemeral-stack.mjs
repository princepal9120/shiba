#!/usr/bin/env node
/**
 * Ephemeral stack — the plain-wrangler stand-in for Alchemy stages
 * (per-PR `staging-{number}` deploys with destroy-on-close).
 *
 * wrangler.jsonc is frozen — no `env.<name>` sections — so this script
 * writes a TEMPORARY override config `.wrangler-ephemeral-<prefix>.jsonc`
 * (a copy of wrangler.jsonc with the worker name suffixed `-<prefix>` and
 * preview_urls forced off), deploys it, smoke-tests the workers.dev URL,
 * then deletes the worker in a finally block (best-effort).
 *
 * Smoke test: GET `/` first — this worker has no `/healthz` route and
 * gates every path behind Access/auth, so ANY HTTP status (401 included)
 * counts as "worker reachable"; only a network error or timeout fails.
 *
 * Usage:
 *   node scripts/ephemeral-stack.mjs [--prefix=<name>] [--wrangler=<path>]
 *                                    [--smoke-timeout-ms=<n>] [--keep]
 *   node scripts/ephemeral-stack.mjs --dry-run [--prefix=<name>]
 *
 * Requires wrangler auth (`npx wrangler whoami`) and CLOUDFLARE secrets in
 * the environment when actually deploying. Never prints .dev.vars contents.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  console.log(`Usage: node scripts/ephemeral-stack.mjs [options]

Options:
  --prefix=<name>          stage prefix (default: test-<unix-ts>)
  --wrangler=<path>        base wrangler config (default: wrangler.jsonc)
  --smoke-timeout-ms=<n>   smoke-test fetch timeout (default: 15000)
  --keep                   skip teardown (leave the ephemeral worker live)
  --dry-run                print the plan without executing anything
  --help                   show this text

Writes .wrangler-ephemeral-<prefix>.jsonc next to wrangler.jsonc, runs
wrangler deploy --config <tmp>, fetches the deployed worker URL (GET / —
the worker has no /healthz; any HTTP status, including the Access-gate
401, counts as reachable), then wrangler delete --config <tmp> (unless
--keep).`);
  process.exit(0);
}

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

const prefix = arg("prefix") ?? `test-${Math.floor(Date.now() / 1000)}`;
if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) {
  console.error(`ephemeral-stack: invalid --prefix "${prefix}" (lowercase dns-safe required)`);
  process.exit(1);
}
const wranglerPath = resolve(root, arg("wrangler") ?? "wrangler.jsonc");
const smokeTimeoutMs = Number(arg("smoke-timeout-ms") ?? 15_000);
const dryRun = flag("dry-run");
const keep = flag("keep");

const log = (msg) => console.log(`[ephemeral] ${msg}`);

let cfg;
try {
  cfg = parseJsonc(readFileSync(wranglerPath, "utf8"));
} catch (err) {
  console.error(`ephemeral-stack: cannot parse ${wranglerPath}: ${err.message}`);
  process.exit(1);
}

const baseName = cfg.name;
const workerName = `${baseName}-${prefix}`;
const tmpConfig = resolve(root, `.wrangler-ephemeral-${prefix}.jsonc`);

const deployCmd = `npx wrangler deploy --config ${tmpConfig}`;
const deleteCmd = `npx wrangler delete --config ${tmpConfig} --name ${workerName}`;

if (dryRun) {
  log(`prefix ${prefix} -> worker name ${workerName}`);
  log(`would write temp config ${tmpConfig} (name="${workerName}", preview_urls=false)`);
  log(`would run: ${deployCmd}`);
  log(`would smoke-test: GET https://${workerName}.<subdomain>.workers.dev/ (any HTTP status = reachable; timeout ${smokeTimeoutMs}ms)`);
  if (keep) log("--keep: teardown skipped");
  else log(`would run: ${deleteCmd}`);
  process.exit(0);
}

cfg.name = workerName;
cfg.preview_urls = false;
// Plain JSON is valid JSONC; write the resolved config rather than patching text.
writeFileSync(tmpConfig, JSON.stringify(cfg, null, 2) + "\n");
log(`wrote ${tmpConfig} (name="${workerName}", preview_urls=false)`);

function run(cmdArgs) {
  const res = spawnSync("npx", cmdArgs, { cwd: root, encoding: "utf8", timeout: 600_000 });
  const out = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  return { ok: !res.error && res.status === 0, out };
}

function pickWorkerUrl(output) {
  const m = output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.workers\.dev/i);
  return m ? m[0] : null;
}

async function smoke(url) {
  // This worker has no /healthz and Access-gates every path: any HTTP
  // status — including 401/404 — proves it is live. Only network failure
  // or timeout counts as a smoke failure.
  for (const path of ["/", "/healthz"]) {
    try {
      const res = await fetch(`${url}${path}`, {
        signal: AbortSignal.timeout(smokeTimeoutMs),
        redirect: "manual",
      });
      log(`smoke: GET ${url}${path} -> ${res.status}`);
      return res.status;
    } catch (err) {
      log(`smoke: GET ${url}${path} failed: ${err.message}`);
    }
  }
  return null;
}

let exitCode = 0;
try {
  log(`deploying ${workerName} ...`);
  const deploy = run(["wrangler", "deploy", "--config", tmpConfig]);
  if (!deploy.ok) {
    console.error(`ephemeral-stack: deploy failed:\n${deploy.out.trim().split("\n").slice(-25).join("\n")}`);
    exitCode = 1;
  } else {
    const url = pickWorkerUrl(deploy.out);
    if (!url) {
      log("no workers.dev URL in deploy output; skipping smoke test");
    } else {
      const status = await smoke(url);
      if (status === null) {
        console.error("ephemeral-stack: smoke test failed (worker unreachable)");
        exitCode = 1;
      }
    }
  }
} finally {
  if (keep) {
    log(`--keep: leaving ${workerName} live; config kept at ${tmpConfig}`);
  } else {
    log(`tearing down ${workerName} ...`);
    const del = run(["wrangler", "delete", "--config", tmpConfig, "--name", workerName]);
    if (!del.ok) {
      console.error(`ephemeral-stack: teardown failed (manual cleanup needed): ${deleteCmd}`);
      exitCode = exitCode || 1;
    }
    rmSync(tmpConfig, { force: true });
    log(`removed ${tmpConfig}`);
  }
  log("done");
}
process.exit(exitCode);
