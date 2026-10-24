#!/usr/bin/env node
/**
 * Shiba operator CLI — `pnpm shiba dev` / `pnpm shiba doctor` / `pnpm shiba setup`.
 * Node stdlib only. Never prints secret values.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import {
  DEV_VARS_PATH,
  REPO_ROOT,
  checkNodeVersion,
  checkPnpmVersion,
  ensureDevVars,
  formatDryRun,
  nextStepsBanner,
  parseDevVars,
  planDevSteps,
} from "./shiba-dev-lib.mjs";
import {
  applyFix,
  buildRecord,
  commitSetup,
  devVarPatch,
  emptyAnswers,
  formatDoctor,
  localDoctor,
  mergeDevVarsText,
  needsLocalContainers,
  normalizeAnswers,
  readSetupFile,
  setupPath,
  splitSecrets,
  writeSetupFile,
} from "./shiba-setup-lib.mjs";

const BACKEND = `${REPO_ROOT}/apps/backend`;
const args = process.argv.slice(2);

function fail(message, code = 1) {
  console.error(`shiba: ${message}`);
  process.exit(code);
}

function flag(name) {
  return args.includes(`--${name}`);
}

function opt(name, fallback) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function capture(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
}

function runStep(step) {
  const env = { ...process.env, ...step.env };
  const result = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    fail(`step ${step.id} failed (${step.cmd} ${step.args.join(" ")})`, result.status ?? 1);
  }
}

function dockerOk() {
  const docker = capture("docker", ["info"], { stdio: "pipe" });
  return docker.status === 0;
}

function devVarFile() {
  return resolve(REPO_ROOT, DEV_VARS_PATH);
}

function readDevVarKeys() {
  const path = devVarFile();
  if (!existsSync(path)) return new Set();
  return new Set(parseDevVars(readFileSync(path, "utf8")).keys());
}

function applyDevVarPatch(patch) {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  ensureDevVars();
  const path = devVarFile();
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, mergeDevVarsText(text, patch), { mode: 0o600 });
  console.log(`  ✓ .dev.vars keys recorded: ${keys.sort().join(", ")}`);
}

function loadAnswersFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    console.log(
      `  ! could not read ${path} (${error instanceof Error ? error.message : "invalid"}) — using skips`,
    );
    return emptyAnswers();
  }
}

async function ask(rl, label, fallback) {
  const answer = (await rl.question(`${label} (${fallback}): `)).trim();
  return answer || fallback;
}

async function promptAnswers() {
  const rl = createInterface({ input, output });
  try {
    console.log("\n== shiba setup ==\nEvery step can be skipped. Tokens are written to .dev.vars and are not printed.\n");
    const githubMode = (await ask(rl, "GitHub access [token/app/skip]", "skip")).toLowerCase();
    let github = { mode: githubMode };
    if (githubMode === "token") {
      const token = (await rl.question("GitHub token (blank to skip): ")).trim();
      github = token ? { mode: "token", token } : { mode: "skip" };
    } else if (githubMode === "app") {
      const appId = (await rl.question("GitHub App id (blank to skip): ")).trim();
      const installationId = (await rl.question("Installation id (blank to skip): ")).trim();
      if (!appId) github = { mode: "skip" };
      else {
        github = { mode: "app", appId, ...(installationId ? { installationId } : {}) };
        console.log("  Paste the App private key into apps/backend/.dev.vars as GITHUB_APP_PRIVATE_KEY.");
      }
    } else if (githubMode !== "skip") {
      console.log(`  unknown GitHub choice ${JSON.stringify(githubMode)} — skipping`);
      github = { mode: "skip" };
    }

    const modelMode = (await ask(rl, "Model [byom/siwc/api-key/skip]", "skip")).toLowerCase();
    let model = { mode: modelMode };
    if (modelMode === "byom" || modelMode === "api-key") {
      const baseUrl = (await rl.question("OpenAI-compatible base URL (blank to skip the URL): ")).trim();
      const credentialRef = (await rl.question("Credential alias (not the secret itself): ")).trim();
      model = {
        mode: modelMode,
        ...(baseUrl ? { baseUrl } : {}),
        ...(credentialRef ? { credentialRef } : {}),
      };
      console.log("  Register that alias on the model connection. Do not paste the API key here.");
    } else if (modelMode === "siwc") {
      console.log("  Sign in with ChatGPT will set SHIBA_CODEX_SUBSCRIPTION=1. Finish auth in the dashboard.");
    } else if (modelMode !== "skip") {
      console.log(`  unknown model choice ${JSON.stringify(modelMode)} — skipping`);
      model = { mode: "skip" };
    }

    const provider = (await ask(rl, "Sandbox [cloudflare/docker-local/computesdk/e2b]", "cloudflare")).toLowerCase();
    const repo = (await rl.question("Test repository URL (https://github.com/owner/repo, blank to skip): ")).trim();
    return normalizeAnswers({
      github,
      model,
      sandbox: { provider },
      testRepo: { url: repo },
    });
  } finally {
    rl.close();
  }
}

function printLocalDoctor(record, docker) {
  const doctor = localDoctor(record, { dockerOk: docker, devVarKeys: readDevVarKeys() });
  console.log(formatDoctor(doctor));
  for (const item of doctor.findings) {
    if (item.severity !== "ok" && item.fixAction) {
      console.log(`  next: pnpm shiba setup fix ${item.fixAction.id}`);
    }
  }
  return doctor;
}

function explainRecord(record) {
  if (record.answers?.testRepo?.url) {
    console.log(`  next: export SHIBA_TEST_REPO=${record.answers.testRepo.url}`);
  }
  if (record.answers?.model?.mode === "byom" && record.answers.model.baseUrl) {
    const alias = record.answers.model.credentialRef ?? "unset";
    console.log(`  next: register a model connection for ${record.answers.model.baseUrl} (alias ${alias})`);
  }
  if (record.answers?.github?.mode === "app") {
    console.log("  next: paste the GitHub App PEM into apps/backend/.dev.vars as GITHUB_APP_PRIVATE_KEY");
  }
  if (record.containers === false) {
    console.log("  containers: disabled for this dev process");
  }
}

async function ensureSetup({ force, answersFile, docker }) {
  const path = setupPath(REPO_ROOT);
  const existing = readSetupFile(path);
  if (!force && !answersFile && existing?.completed === true) {
    console.log("  ✓ setup already recorded (.shiba/setup.json). Re-run with pnpm shiba setup to change it.");
    return existing;
  }
  let answers;
  if (answersFile) answers = loadAnswersFile(resolve(REPO_ROOT, answersFile));
  else if (input.isTTY) answers = await promptAnswers();
  else {
    console.log("  ! no terminal — recording skipped steps. Run pnpm shiba setup when you can answer.");
    answers = emptyAnswers();
  }
  const committed = commitSetup(REPO_ROOT, answers, { dockerOk: docker, devVarKeys: readDevVarKeys() });
  applyDevVarPatch(committed.patch);
  console.log(`  ✓ wrote ${path}`);
  printLocalDoctor(committed.record, docker);
  explainRecord(committed.record);
  return committed.record;
}

function checkPrerequisites() {
  const node = checkNodeVersion();
  if (!node.ok) {
    fail(`Node.js ${node.min}+ required (found ${node.version})`);
  }

  const pnpm = capture("pnpm", ["--version"], { cwd: REPO_ROOT });
  if (pnpm.status !== 0) {
    fail("pnpm is required — install pnpm 10+ and re-run");
  }
  const pnpmCheck = checkPnpmVersion(pnpm.stdout);
  if (!pnpmCheck.ok) {
    fail(`pnpm ${pnpmCheck.min}+ required (found ${pnpmCheck.version})`);
  }

  const wrangler = capture("npx", ["wrangler", "--version"], { cwd: REPO_ROOT });
  if (wrangler.status !== 0) {
    fail("wrangler not available — run pnpm install from the repo root");
  }

  const docker = dockerOk();
  console.log("  ✓ Node.js", node.version);
  console.log("  ✓ pnpm", pnpmCheck.version.trim());
  console.log("  ✓ wrangler", (wrangler.stdout || wrangler.stderr).trim().split("\n")[0]);
  if (docker) console.log("  ✓ docker");
  else console.log("  ! docker unavailable — continuing with local containers off");
  return { dockerOk: docker };
}

function containersFor(record, docker) {
  if (!docker) return false;
  if (!record) return true;
  if (record.containers === false) return false;
  return needsLocalContainers({ ...record, containers: true });
}

async function cmdDev() {
  const dryRun = flag("dry-run");
  const onlyDevVars = flag("only-dev-vars");
  const skipInstall = flag("skip-install") || existsSync(resolve(REPO_ROOT, "node_modules/.pnpm"));
  const skipBuild = flag("skip-build");
  const skipImage = flag("skip-image");
  const skipSetup = flag("skip-setup");
  const port = Number(opt("port", "8788"));
  const persistTo = opt("persist-to", ".shiba/local-state");
  const answersFile = opt("answers", "");

  if (onlyDevVars) {
    const { appended } = ensureDevVars();
    if (appended.length) {
      console.log(`  ✓ apps/backend/.dev.vars updated (${appended.length} local secret(s) minted)`);
    } else {
      console.log("  ✓ apps/backend/.dev.vars ready");
    }
    return;
  }

  if (dryRun) {
    const plan = planDevSteps({
      skipInstall,
      skipBuild,
      skipImage,
      port,
      persistTo,
    });
    console.log(formatDryRun(plan));
    console.log("setup: skipped on dry-run (pnpm shiba setup)");
    console.log(nextStepsBanner({ port }));
    return;
  }

  console.log("\n== shiba dev (local Worker + Sandbox) ==\n");
  const prereq = checkPrerequisites();
  const record = skipSetup
    ? readSetupFile(setupPath(REPO_ROOT))
    : await ensureSetup({ force: flag("setup"), answersFile, docker: prereq.dockerOk });
  const containers = containersFor(record, prereq.dockerOk);

  const plan = planDevSteps({
    skipInstall,
    skipBuild,
    skipImage,
    port,
    persistTo,
    containers,
  });

  ensureDevVars();
  const devVarsPath = resolve(REPO_ROOT, DEV_VARS_PATH);
  const loopbackSecret =
    process.env.SHIBA_DEV_OAUTH_LOOPBACK_SECRET?.trim() ??
    (existsSync(devVarsPath)
      ? (parseDevVars(readFileSync(devVarsPath, "utf8")).get("SHIBA_DEV_OAUTH_LOOPBACK_SECRET")?.trim() ?? "")
      : "");
  const oauthLoopback = spawn("node", ["scripts/oauth-loopback.mjs"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    detached: false,
    env: {
      ...process.env,
      SHIBA_WORKER_URL: `http://127.0.0.1:${port}`,
      SHIBA_DEV_OAUTH_LOOPBACK_SECRET: loopbackSecret,
    },
  });
  oauthLoopback.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[oauth-loopback] exited ${code}`);
    }
  });

  let generatedKeys = [];
  for (const step of plan.steps) {
    if (step.id === "dev-vars") {
      const { appended } = ensureDevVars();
      generatedKeys = appended;
      if (appended.length) {
        console.log(`  ✓ .dev.vars (${appended.length} local secret(s) minted, existing values kept)`);
      } else {
        console.log("  ✓ .dev.vars");
      }
      continue;
    }
    console.log(`\n→ ${step.id}`);
    runStep(step);
  }

  console.log(nextStepsBanner({ port, generatedKeys }));
}

function parseDoctorArgs(argv) {
  const opts = { strict: false, json: false, host: process.env.SHIBA_HOST ?? "http://127.0.0.1:8788" };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "doctor") continue;
    if (arg === "--strict") opts.strict = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--host") {
      const value = rest.shift();
      if (!value) fail("--host requires a URL.");
      opts.host = value.replace(/\/$/, "");
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm shiba doctor [--host URL] [--strict] [--json]");
      process.exit(0);
    } else {
      fail(`unknown argument ${JSON.stringify(arg)}`);
    }
  }
  return opts;
}

function localChecks() {
  const lines = [];
  const devVars = `${BACKEND}/.dev.vars`;
  if (existsSync(devVars)) {
    const body = readFileSync(devVars, "utf8");
    lines.push(/^GITHUB_TOKEN=.+$/m.test(body) ? "local GITHUB_TOKEN=present" : "local GITHUB_TOKEN=absent");
  } else {
    lines.push("local .dev.vars=missing");
  }
  const docker = spawnSync("docker", ["info"], { stdio: "ignore" });
  lines.push(docker.status === 0 ? "docker=ok" : "docker=unavailable (sandbox runs need a local engine)");
  return lines;
}

async function fetchDoctor(host) {
  const response = await fetch(`${host}/api/setup/status`, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`GET /api/setup/status → ${response.status}`);
  }
  const body = await response.json();
  if (!body?.doctor) {
    throw new Error("Response missing doctor field — is the Worker on this branch?");
  }
  return body.doctor;
}

function printDoctor(doctor) {
  const lines = [];
  lines.push(doctor.ok ? "setup doctor: ok" : "setup doctor: problems found");
  for (const finding of doctor.findings ?? []) {
    const tag = finding.severity === "ok" ? "✓" : finding.severity === "warn" ? "!" : "✗";
    lines.push(`${tag} ${finding.id}: ${finding.message}`);
    if (finding.fix) lines.push(`    fix: ${finding.fix}`);
    if (finding.fixAction) {
      lines.push(`    action: pnpm shiba setup fix ${finding.fixAction.id} — ${finding.fixAction.label}`);
    }
  }
  for (const row of doctor.roles ?? []) {
    const route =
      `${row.role} → ${row.harness} / ${row.model}` + (row.connectionId ? ` (${row.connectionId})` : "");
    lines.push(row.ok ? `✓ ${route}` : `✗ ${route}: ${row.message ?? "blocked"}`);
    if (!row.ok && row.fix) lines.push(`    fix: ${row.fix}`);
  }
  return lines.join("\n");
}

async function cmdDoctor() {
  const opts = parseDoctorArgs(args);
  for (const line of localChecks()) {
    console.log(line);
  }
  try {
    const doctor = await fetchDoctor(opts.host);
    if (opts.json) {
      console.log(JSON.stringify(doctor, null, 2));
    } else {
      console.log(printDoctor(doctor));
    }
    if (opts.strict && !doctor.ok) process.exit(1);
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)} — start the Worker (pnpm dev:backend) or pass --host.`,
    );
  }
}

async function cmdSetup() {
  const rest = args.slice(1).filter((arg) => arg !== "setup");
  if (rest[0] === "fix") {
    const actionId = rest[1];
    if (!actionId || actionId.startsWith("--")) {
      console.log("Usage: pnpm shiba setup fix <actionId>");
      console.log("Actions: sandbox.use-cloudflare, sandbox.use-docker-local, sandbox.use-computesdk, sandbox.use-e2b, sandbox.without-docker, guide.github, guide.model, guide.test-repo");
      return;
    }
    const path = setupPath(REPO_ROOT);
    const existing = readSetupFile(path) ?? {
      version: 1,
      answers: emptyAnswers(),
      containers: true,
      acknowledged: [],
    };
    const applied = applyFix(existing, actionId);
    writeSetupFile(path, applied.record);
    if (actionId.startsWith("sandbox.")) applyDevVarPatch(devVarPatch(applied.record.answers, {}));
    console.log(applied.message);
    printLocalDoctor(applied.record, dockerOk());
    return;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log("Usage: pnpm shiba setup [--answers=file.json] [--dry-run]");
    console.log("       pnpm shiba setup fix <actionId>");
    return;
  }
  const docker = dockerOk();
  const answersFile = opt("answers", "");
  if (flag("dry-run")) {
    const answers = answersFile ? loadAnswersFile(resolve(REPO_ROOT, answersFile)) : emptyAnswers();
    const { saved } = splitSecrets(normalizeAnswers(answers));
    const preview = buildRecord(saved, { dockerOk: docker, devVarKeys: readDevVarKeys() });
    console.log(formatDoctor(preview.doctor));
    console.log("dry-run: nothing written");
    return;
  }
  await ensureSetup({ force: true, answersFile, docker });
}

function printHelp() {
  console.log(`Usage: pnpm shiba <command> [options]

Commands:
  dev      Setup wizard, then local Worker + Sandbox
  setup    GitHub, model, sandbox, and test-repo wizard (every step skippable)
  doctor   Local checks + live /api/setup/status from a running Worker

Dev options:
  --dry-run           Print the planned commands without running them
  --skip-setup        Skip the wizard (use .shiba/setup.json if it exists)
  --setup             Run the wizard even when a completed record exists
  --answers=<file>    Non-interactive wizard answers (JSON)
  --skip-install      Skip pnpm install (default when node_modules exists)
  --skip-build        Skip pnpm build
  --skip-image        Skip wrangler containers build
  --port=<n>          Wrangler port (default: 8788)
  --persist-to=<dir>  Local persistence directory (default: .shiba/local-state)
  --only-dev-vars     Internal: merge .dev.vars only

Setup:
  pnpm shiba setup
  pnpm shiba setup fix <actionId>

Doctor options:
  --host URL          Worker base URL (default: http://127.0.0.1:8788 or SHIBA_HOST)
  --strict            Exit 1 when doctor reports problems
  --json              Print doctor JSON

Examples:
  pnpm shiba dev
  pnpm shiba dev --dry-run
  pnpm shiba setup
  pnpm shiba doctor --strict
  bash scripts/dev.sh
`);
}

const sub = args[0];
if (!sub || sub === "--help" || sub === "-h") {
  printHelp();
  process.exit(sub ? 0 : 1);
}

if (sub === "dev") {
  await cmdDev();
} else if (sub === "setup") {
  await cmdSetup();
} else if (sub === "doctor") {
  await cmdDoctor();
} else {
  fail(`unknown command "${sub}" — run pnpm shiba --help`);
}
