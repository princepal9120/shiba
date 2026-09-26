/**
 * pnpm run bootstrap — one-command self-hosted deploy with Alchemy.
 * Collects config into .env (gitignored), connects Alchemy to Cloudflare
 * once (browser OAuth), then builds and runs `alchemy deploy`. Re-run anytime; answers persist.
 * Node stdlib only.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const ENV_FILE = ".env";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ok = (s) => console.log(`  ✓ ${s}`);
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", ...opts });
const capture = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

const env = {};
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) env[m[1]] = m[2];
  }
}
const save = () =>
  writeFileSync(ENV_FILE, Object.entries(env).filter(([, v]) => v !== "").map(([k, v]) => `${k}=${v}`).join("\n") + "\n", { mode: 0o600 });
const ask = async (name, hint, fallback = env[name] ?? "") => {
  const shown = fallback && /TOKEN|SECRET|KEY/.test(name) ? "<kept>" : fallback;
  const answer = (await rl.question(`${name} — ${hint}${shown ? ` [${shown}]` : ""}: `)).trim();
  env[name] = answer || fallback;
};

console.log("\n== shiba-ai-coworker bootstrap (Alchemy) ==\n");

// 1. Preflight: container images build locally.
if (capture("docker", ["info"]).status !== 0) {
  console.log("Docker daemon not running — start Docker Desktop/OrbStack and re-run.");
  process.exit(1);
}
ok("docker running");

// 2. Cloudflare credentials for Alchemy: browser OAuth (includes Access scopes), stored in ~/.alchemy.
const who = capture("npx", ["wrangler", "whoami"]);
const accountEmail = (/associated with the email (\S+?)\.?\s/.exec(`${who.stdout}${who.stderr}`) ?? [])[1] ?? "";
const profile = capture("npx", ["alchemy", "profile", "show", "--no-input"]);
if (!process.env.CLOUDFLARE_API_TOKEN && !env.CLOUDFLARE_API_TOKEN && !/cloudflare/i.test(`${profile.stdout}`)) {
  console.log("Connecting Alchemy to Cloudflare (a browser window opens — approve it)…");
  if (run("npx", ["alchemy", "profile", "edit", "--add", "Cloudflare", "--method", "oauth"]).status !== 0) {
    console.log("Login failed — or set CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in .env, then re-run.");
    process.exit(1);
  }
}
ok("alchemy connected to Cloudflare");

// 3. Config. Access gates the dashboard; the workers.dev subdomain names its hostname.
console.log("\n== Access (dashboard login for web + iPhone) ==");
await ask("ACCESS_EMAILS", "emails allowed to sign in, comma-separated", env.ACCESS_EMAILS ?? accountEmail);
await ask("WORKERS_SUBDOMAIN", "your account's workers.dev subdomain (the <x> in *.<x>.workers.dev)");

console.log("\n== Secrets (blank = skip; stored only in .env) ==");
for (const [name, hint] of [
  ["GITHUB_TOKEN", "fine-grained GitHub PAT (clone + open PRs)"],
  ["AI_GATEWAY_TOKEN", "AI Gateway token, if the 'default' gateway is authenticated"],
  ["SLACK_SIGNING_SECRET", "Slack app signing secret"],
  ["SLACK_BOT_TOKEN", "Slack bot token xoxb-…"],
  ["SLACK_APPROVERS", "Slack user ids allowed to approve, comma-separated"],
  ["SLACK_CHANNEL_REPOS", "channel→repo map, e.g. C0123=https://github.com/o/r"],
  ["GITHUB_WEBHOOK_SECRET", "GitHub webhook secret (automations)"],
  ["TYPESAFE_API_KEY", "TypeSafe key (optional)"],
  ["DEVIN_API_KEY", "Devin API key (optional)"],
]) {
  await ask(name, hint);
}
save();
ok(".env written (mode 600, gitignored) — alchemy.run.ts binds every secret present there");
rl.close();

// 4. Build + deploy. Alchemy replaces all secrets on each deploy, so .env is the source of truth.
if (run("pnpm", ["build"]).status !== 0) process.exit(1);
if (run("npx", ["alchemy", "deploy"]).status !== 0) {
  console.log("Deploy failed — fix the error above and re-run `pnpm run bootstrap`.");
  process.exit(1);
}

const host = env.WORKERS_SUBDOMAIN ? `shiba-ai-coworker.${env.WORKERS_SUBDOMAIN}.workers.dev` : "<worker-host>";
console.log(`
== Deployed ==
Dashboard (web + iPhone: open in Safari → Share → Add to Home Screen):
  https://${host}/app/
Claude Code (MCP):
  node scripts/mint-token.mjs --agent claude-code --scopes sandbox:exec --host ${host} \\
    --namespace-id <agentTokensNamespace from the deploy output above> --write
  → prints the \`claude mcp add\` line to paste
Slack: https://api.slack.com/apps?new_app=1 → From a manifest → slack-app-manifest.yaml
  with YOUR-WORKER.workers.dev replaced by ${host}; then add the signing secret and
  bot token to .env and re-run \`pnpm run bootstrap\`.
AI Gateway: add a provider key (BYOK) to gateway "default" in the dashboard.
Check: https://${host}/api/setup/status (after signing in)
`);
