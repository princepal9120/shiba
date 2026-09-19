/**
 * pnpm setup — one-command bootstrap for a self-hosted deploy.
 * Automates what's automatable (deploy, secrets, AI Gateway, Access) and
 * prints exact manual steps for what isn't (BYOK provider key, Slack app).
 * Node stdlib + wrangler CLI only.
 */
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, fallback = "") => rl.question(`${q}${fallback ? ` [${fallback}]` : ""}: `).then((a) => a.trim() || fallback);
const askSecret = (q) => ask(`${q} (blank = skip)`);
const ok = (s) => console.log(`  ✓ ${s}`);
const note = (s) => console.log(`  · ${s}`);

const run = (cmd, args, input) =>
  spawnSync(cmd, args, { input, encoding: "utf8", stdio: input !== undefined ? ["pipe", "inherit", "inherit"] : "inherit" });

const CF_API = "https://api.cloudflare.com/client/v4";
async function cf(token, method, path, body) {
  const res = await fetch(`${CF_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

// 1. wrangler auth
console.log("\n== ai-intern setup ==\n");
const whoami = spawnSync("npx", ["wrangler", "whoami"], { encoding: "utf8" });
if (whoami.status !== 0 || /not authenticated/i.test(whoami.stdout + whoami.stderr)) {
  console.log("Not logged in. Run: npx wrangler login — then re-run pnpm setup.");
  process.exit(1);
}
const accountId = (whoami.stdout.match(/[0-9a-f]{32}/) ?? [])[0];
ok(`wrangler authenticated${accountId ? ` (account ${accountId.slice(0, 8)}…)` : ""}`);

// 2. deploy
if ((await ask("Deploy now with `wrangler deploy`? (y/n)", "y")).toLowerCase() === "y") {
  const deploy = run("npx", ["wrangler", "deploy"]);
  if (deploy.status !== 0) { console.log("Deploy failed — fix the error above and re-run."); process.exit(1); }
  ok("deployed");
}
const workerHost = await ask("Worker host (no scheme)", "ai-intern.<subdomain>.workers.dev");
const workerUrl = `https://${workerHost}`;

// 3. secrets
console.log("\n== Secrets (blank skips; re-run anytime) ==");
const secrets = [
  ["SLACK_SIGNING_SECRET", "Slack signing secret (app Basic Information page)"],
  ["SLACK_BOT_TOKEN", "Slack bot token xoxb-… (enables mention approval cards)"],
  ["SLACK_APPROVERS", "Approver Slack user ids, comma-separated (e.g. U0123,U0456)"],
  ["AI_GATEWAY_TOKEN", "AI Gateway token (gateway → settings → authenticated gateway)"],
  ["GITHUB_TOKEN", "Fine-grained GitHub PAT (only needed to open PRs)"],
  ["GITHUB_WEBHOOK_SECRET", "GitHub webhook secret (automations)"],
  ["TYPESAFE_API_KEY", "TypeSafe API key (optional; run_when falls back to Workers AI)"],
];
const collected = {};
for (const [name, hint] of secrets) {
  const value = await askSecret(`${name} — ${hint}`);
  if (!value) { note(`${name} skipped`); continue; }
  const r = run("npx", ["wrangler", "secret", "put", name], value + "\n");
  if (r.status === 0) { ok(`${name} set`); collected[name] = value; }
  else note(`${name} failed — set later with: npx wrangler secret put ${name}`);
}
if (await ask("Require Cloudflare Access on the dashboard/API? (y/n)", "y") === "y") {
  collected.REQUIRE_ACCESS = "1";
  // Plain var, not a secret — wrangler secret put cannot set it.
  note('add "REQUIRE_ACCESS": "1" under "vars" in wrangler.jsonc and re-run wrangler deploy');
}

// 4. optional CF API automation
console.log("\n== Optional: Cloudflare API automation ==");
const apiToken = await askSecret("API token w/ AI Gateway + Access edit on this account");
if (apiToken && accountId) {
  const gw = await cf(apiToken, "POST", `/accounts/${accountId}/ai-gateway/gateways`, { id: "default", name: "default" });
  gw.success || (gw.errors ?? []).some((e) => /already exists|taken/i.test(e.message))
    ? ok('AI Gateway "default" ready')
    : note(`gateway create failed: ${JSON.stringify(gw.errors)}`);
  const email = await ask("Access: allow which email?", "");
  if (email) {
    const app = await cf(apiToken, "POST", `/accounts/${accountId}/access/apps`, {
      name: "ai-intern", domain: workerHost, type: "self_hosted", session_duration: "24h",
    });
    if (app.success) {
      const pol = await cf(apiToken, "POST", `/accounts/${accountId}/access/apps/${app.result.id}/policies`, {
        name: "owner", decision: "allow", include: [{ email: { email } }], precedence: 1,
      });
      pol.success ? ok(`Access policy allows ${email}`) : note(`Access policy failed: ${JSON.stringify(pol.errors)}`);
    } else note(`Access app failed: ${JSON.stringify(app.errors)}`);
  }
}

// 5. local dev vars
if (Object.keys(collected).length && await ask("Write secrets to .dev.vars for `wrangler dev`? (y/n)", "n") === "y") {
  const lines = Object.entries(collected).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  const existing = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
  writeFileSync(".dev.vars", existing + lines);
  ok(".dev.vars appended (gitignored)");
}

// 6. manual steps
console.log(`
== Manual steps (cannot be automated) ==
1. Slack app: https://api.slack.com/apps?new_app=1 → "From a manifest" →
   paste slack-app-manifest.yaml with YOUR-WORKER = ${workerHost}
   URLs: events ${workerUrl}/api/slack/events · interact .../api/slack/interact · command .../api/slack/command
2. AI Gateway: add a BYOK provider key (Google/Anthropic/OpenAI) at
   https://dash.cloudflare.com/?to=/:account/ai/ai-gateway → gateway "default".
   If the gateway is auth-gated, mint a token and set AI_GATEWAY_TOKEN.
3. Verify: ${workerUrl}/api/setup/status should show all green, then
   open ${workerUrl}/app/ for the guided first run.
`);
rl.close();
