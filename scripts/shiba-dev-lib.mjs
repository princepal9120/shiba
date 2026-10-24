/**
 * Shared logic for `pnpm shiba dev` / scripts/dev.sh — local Worker + Sandbox.
 * Node stdlib only; exported for unit tests.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WRANGLER_CONFIG = "apps/backend/wrangler.jsonc";
export const DEV_VARS_EXAMPLE = "apps/backend/.dev.vars.example";
export const DEV_VARS_PATH = "apps/backend/.dev.vars";
export const DEFAULT_PORT = 8788;
export const DEFAULT_PERSIST = ".shiba/local-state";
export const CONTAINER_IMAGE_TAG = "shiba-ai-coworker-sandbox:local";

/** Secrets safe to mint locally; never overwrite a non-empty existing value. */
export const AUTO_GENERATE_KEYS = [
  "INTERNAL_SIGNING_KEY",
  "PAIRING_SECRET",
  "LOCAL_ADAPTER_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "TRIGGER_TOKEN",
  "SHIBA_DEV_OAUTH_LOOPBACK_SECRET",
];

export function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

export function randomBase64Url(bytes) {
  return randomBytes(bytes).toString("base64url");
}

/** @param {() => string} [rng] injectable for tests */
export function secretForKey(key, rng = () => randomHex(32)) {
  if (key === "BETTER_AUTH_SECRET") return randomBase64Url(48);
  return rng();
}

export function parseDevVars(text) {
  const values = new Map();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    values.set(name, value);
  }
  return values;
}

/**
 * Ensure `.dev.vars` exists from the example and mint missing AUTO_GENERATE keys.
 * @returns {{ created: boolean, appended: string[], path: string }}
 */
export function ensureDevVars({
  root = REPO_ROOT,
  exampleRel = DEV_VARS_EXAMPLE,
  devVarsRel = DEV_VARS_PATH,
  generate = secretForKey,
} = {}) {
  const examplePath = resolve(root, exampleRel);
  const devVarsPath = resolve(root, devVarsRel);
  const exampleText = readFileSync(examplePath, "utf8");
  const created = !existsSync(devVarsPath);
  const existingText = created ? exampleText : readFileSync(devVarsPath, "utf8");
  const values = parseDevVars(existingText);
  const appended = [];

  for (const key of AUTO_GENERATE_KEYS) {
    const current = values.get(key)?.trim() ?? "";
    if (current) continue;
    const value = generate(key);
    values.set(key, value);
    appended.push(key);
  }

  if (appended.length === 0 && !created) {
    return { created: false, appended, path: devVarsPath };
  }

  let out = existingText.replace(/\n?$/, "\n");
  if (appended.length > 0) {
    if (!out.includes("# --- Generated local secrets (pnpm shiba dev) ---")) {
      out += "\n# --- Generated local secrets (pnpm shiba dev) ---\n";
    }
    for (const key of appended) {
      out += `${key}=${values.get(key)}\n`;
    }
  }

  mkdirSync(dirname(devVarsPath), { recursive: true });
  writeFileSync(devVarsPath, out, { mode: 0o600 });
  return { created, appended, path: devVarsPath };
}

export function parseSemver(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

export function semverGte(a, b) {
  if (!a || !b) return false;
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}

export function checkNodeVersion(version = process.version) {
  const parsed = parseSemver(version);
  const min = parseSemver("22.13.0");
  return { ok: semverGte(parsed, min), version, min: "22.13.0" };
}

export function checkPnpmVersion(stdout) {
  const parsed = parseSemver(stdout.trim());
  const min = parseSemver("10.0.0");
  return { ok: semverGte(parsed, min), version: stdout.trim(), min: "10.0.0" };
}

export function planDevSteps({
  root = REPO_ROOT,
  port = DEFAULT_PORT,
  persistTo = DEFAULT_PERSIST,
  skipInstall = false,
  skipBuild = false,
  skipImage = false,
  containers = true,
} = {}) {
  const persistAbs = resolve(root, persistTo);
  const wranglerRel = WRANGLER_CONFIG;
  const backendRel = "apps/backend";
  const steps = [];

  if (!skipInstall) {
    steps.push({ id: "install", cmd: "pnpm", args: ["install"], cwd: root });
  }
  if (!skipBuild) {
    steps.push({ id: "build", cmd: "pnpm", args: ["build"], cwd: root });
  }
  steps.push({
    id: "dev-vars",
    cmd: "ensureDevVars",
    args: [],
    cwd: root,
    note: "create apps/backend/.dev.vars from example; mint AUTO_GENERATE keys without overwriting existing values",
  });
  steps.push({
    id: "d1-migrate",
    cmd: "npx",
    args: [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "shiba-audit",
      "--local",
      `--config=${wranglerRel}`,
      `--persist-to=${persistAbs}`,
    ],
    cwd: root,
    env: { CI: "1" },
  });
  if (!skipImage && containers) {
    steps.push({
      id: "container-build",
      cmd: "npx",
      args: [
        "wrangler",
        "containers",
        "build",
        `-t=${CONTAINER_IMAGE_TAG}`,
        backendRel,
        `--config=${wranglerRel}`,
      ],
      cwd: root,
    });
  }
  const wranglerArgs = [
    "wrangler",
    "dev",
    `--config=${wranglerRel}`,
    `--port=${port}`,
    `--persist-to=${persistAbs}`,
    "--local-upstream",
    "localhost",
  ];
  if (!containers) wranglerArgs.push("--enable-containers=false");
  steps.push({
    id: "wrangler-dev",
    cmd: "npx",
    args: wranglerArgs,
    cwd: root,
    note: containers
      ? "containers enabled when Docker is running (default)"
      : "containers disabled (--enable-containers=false)",
  });

  return { steps, persistAbs, port, appUrl: `http://127.0.0.1:${port}/app/` };
}

export function formatDryRun(plan) {
  const lines = ["shiba dev — dry run (no commands executed)", ""];
  for (const step of plan.steps) {
    const env = step.env ? ` env:${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(" ")}` : "";
    const note = step.note ? `  # ${step.note}` : "";
    lines.push(`[${step.id}]${env}`);
    if (step.args.length > 0 || step.cmd.includes(" ")) {
      lines.push(`  ${step.cmd} ${step.args.join(" ")}${note}`);
    } else {
      lines.push(`  (${step.cmd})${note}`);
    }
  }
  lines.push("");
  lines.push(`App URL: ${plan.appUrl}`);
  lines.push(`Setup status: http://127.0.0.1:${plan.port}/api/setup/status`);
  lines.push(`Persist: ${plan.persistAbs}`);
  return lines.join("\n");
}

export function nextStepsBanner({ port = DEFAULT_PORT, generatedKeys = [] } = {}) {
  const base = `http://127.0.0.1:${port}`;
  const lines = [
    "",
    "== Shiba local dev ==",
    `Dashboard: ${base}/app/`,
    `Setup API: ${base}/api/setup/status`,
    "",
    "Next steps:",
    "  1. Add GITHUB_TOKEN to apps/backend/.dev.vars (fine-grained PAT: repo Contents + Pull requests).",
    "  2. Sign in on Providers (Codex, Claude, Cursor, Grok, Antigravity) — OAuth loopback on :51121 and :56121 is already running.",
    "  3. For the full dashboard + Worker together: pnpm dev (Vite :5173 proxies /api to :8788).",
    "  4. Add model access: AI Gateway BYOK or AI_GATEWAY_TOKEN; npx wrangler login once for container pulls.",
    "",
  ];
  if (generatedKeys.length > 0) {
    lines.push(`Minted local-only secrets (not printed): ${generatedKeys.join(", ")}`);
    lines.push("");
  }
  lines.push("Gate before shipping changes:");
  lines.push("  pnpm typecheck && pnpm lint && pnpm test && pnpm build");
  lines.push("");
  return lines.join("\n");
}
