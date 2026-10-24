#!/usr/bin/env node
/**
 * `pnpm dev` — Worker (:8788), dashboard (Vite :5173), OAuth loopback (51121/56121).
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import {
  DEFAULT_PERSIST,
  DEFAULT_PORT,
  DEV_VARS_PATH,
  ensureDevVars,
  parseDevVars,
  planDevSteps,
  WRANGLER_CONFIG,
} from "./shiba-dev-lib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number.parseInt(process.env.SHIBA_DEV_PORT ?? String(DEFAULT_PORT), 10);
const persistAbs = resolve(ROOT, process.env.SHIBA_PERSIST_TO ?? DEFAULT_PERSIST);

const children = [];

function run(cmd, args, label, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...opts.env },
    ...opts,
  });
  child.on("exit", (code, signal) => {
    if (signal) return;
    if (code !== 0 && code !== null) {
      console.error(`[local-dev] ${label} exited ${code}`);
      shutdown(code ?? 1);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    child.kill("SIGTERM");
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

ensureDevVars({ root: ROOT });
const devVars = parseDevVars(readFileSync(resolve(ROOT, DEV_VARS_PATH), "utf8"));
const loopbackSecret = devVars.get("SHIBA_DEV_OAUTH_LOOPBACK_SECRET")?.trim() ?? "";

spawnSync(
  "npx",
  [
    "wrangler",
    "d1",
    "migrations",
    "apply",
    "shiba-audit",
    "--local",
    `--config=${WRANGLER_CONFIG}`,
    `--persist-to=${persistAbs}`,
  ],
  { cwd: ROOT, stdio: "inherit", env: { ...process.env, CI: "1" } },
);

run("node", ["scripts/oauth-loopback.mjs"], "oauth-loopback", {
  env: {
    SHIBA_WORKER_URL: `http://127.0.0.1:${PORT}`,
    SHIBA_DEV_OAUTH_LOOPBACK_SECRET: loopbackSecret,
  },
});

const wranglerStep = planDevSteps({
  root: ROOT,
  port: PORT,
  persistTo: process.env.SHIBA_PERSIST_TO ?? DEFAULT_PERSIST,
  skipInstall: true,
  skipBuild: true,
  skipImage: true,
  containers: false,
}).steps.find((step) => step.id === "wrangler-dev");

if (wranglerStep) {
  run(wranglerStep.cmd, wranglerStep.args, "wrangler-dev", { env: wranglerStep.env });
}

run(
  "pnpm",
  ["exec", "turbo", "run", "dev", "--filter=@shiba/frontend"],
  "vite-dev",
);

console.log(
  `[local-dev] dashboard http://localhost:5173  worker http://127.0.0.1:${PORT}  persist ${persistAbs}`,
);
