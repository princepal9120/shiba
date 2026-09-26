#!/usr/bin/env node
// Mint an /mcp bearer token as the same KV record createToken (apps/backend/src/agent-tokens.ts) writes.
// Usage: node scripts/mint-token.mjs --agent <name> --scopes <a,b> [--ttl-days N] [--host <host>] [--write]
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// Mirrors agent-tokens.ts; apps/backend/test/mint-token.test.ts fails on drift.
const SCOPES = [
  "email:read",
  "email:draft",
  "email:send",
  "email:delete",
  "memory:read",
  "memory:write",
  "runs:read",
  "sandbox:exec",
  "admin:tokens",
];
const TOKEN_ID_BYTES = 8;
const TOKEN_SECRET_BYTES = 24;
const MAX_PRINCIPAL_LENGTH = 128;
const WRANGLER_CONFIG = "apps/backend/wrangler.jsonc";
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

function sha256Hex(input) {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function fail(message) {
  console.error(`mint-token: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") {
      opts.write = true;
    } else if (arg === "--agent" || arg === "--scopes" || arg === "--ttl-days" || arg === "--host" || arg === "--namespace-id") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        fail(`${arg} requires a value.`);
      }
      opts[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/mint-token.mjs --agent <name> --scopes <a,b,c> [--ttl-days N] [--host <worker-host>] [--namespace-id <id>] [--write]\n" +
          "  --namespace-id: the agentTokensNamespace printed by `pnpm run deploy` (Alchemy owns the KV, not wrangler.jsonc)\n" +
          `Valid scopes: ${SCOPES.join(", ")}`,
      );
      process.exit(0);
    } else {
      fail(`unknown argument "${arg}".`);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));

const principal = typeof opts.agent === "string" ? opts.agent.trim() : "";
if (principal === "" || principal.length > MAX_PRINCIPAL_LENGTH || /\s/.test(principal)) {
  fail("--agent must be a non-empty name without whitespace (max 128 chars).");
}

const scopes = [...new Set(
  String(opts.scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
)];
if (scopes.length === 0) {
  fail("--scopes must grant at least one scope.");
}
for (const scope of scopes) {
  if (!SCOPES.includes(scope)) {
    fail(`unknown scope "${scope}". Valid scopes: ${SCOPES.join(", ")}`);
  }
}

let ttlSeconds;
if (opts.ttlDays !== undefined) {
  const days = Number(opts.ttlDays);
  if (!Number.isFinite(days) || days <= 0) {
    fail("--ttl-days must be a positive number.");
  }
  // KV enforces expiry in seconds from write time.
  ttlSeconds = Math.ceil(days * 86400);
}

const token = `shb_${randomHex(TOKEN_ID_BYTES)}_${randomHex(TOKEN_SECRET_BYTES)}`;
const record = {
  principal,
  scopes,
  created: Date.now(),
  revoked: false,
};
const key = `tok_${sha256Hex(token)}`;
const value = JSON.stringify(record);

const wranglerArgs = [
  "wrangler",
  "kv",
  "key",
  "put",
  // Alchemy deploys create their own KV; its id wins over wrangler.jsonc's binding.
  ...(opts.namespaceId ? ["--namespace-id", opts.namespaceId] : ["--binding", "AGENT_TOKENS", "--config", WRANGLER_CONFIG]),
  key,
  value,
  "--remote",
  ...(ttlSeconds !== undefined ? ["--ttl", String(ttlSeconds)] : []),
];
const command = `npx ${wranglerArgs.map((a) => (/[\s"']/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(" ")}`;

const host = (opts.host ?? "<your-worker-host>").replace(/^https?:\/\//, "").replace(/\/+$/, "");
const mcpLine = `claude mcp add --transport http shiba https://${host}/mcp --header "Authorization: Bearer ${token}"`;

console.log(`token:   ${token}`);
console.log(`key:     ${key}`);
console.log(`value:   ${value}`);
console.log(`command: ${command}   # from the repo root`);
console.log(`\n${mcpLine}`);

if (opts.write) {
  const result = spawnSync("npx", wranglerArgs, { stdio: "inherit", cwd: REPO_ROOT });
  if (result.status !== 0) {
    fail(`wrangler kv key put exited with ${result.status ?? "signal " + result.signal}.`);
  }
  console.error("mint-token: record written to remote AGENT_TOKENS.");
}
