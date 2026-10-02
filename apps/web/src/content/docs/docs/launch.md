---
title: Launch
description: One-command deploy — pnpm bootstrap collects config, connects Cloudflare, builds, deploys, and prints the dashboard-only follow-ups.
---

# Launch — one command to a running stack

`pnpm run bootstrap` walks every step end to end: `.env` collection, Cloudflare
connection, build, deploy, and a printed checklist for what only the dashboard
can do (Access, Email Routing, Slack/Telegram/Discord app creation). Re-run it
any time — answers persist in `.env` (gitignored, mode 600).

## What the script does

1. **Preflight** — verifies a Docker daemon is reachable (container builds) and
   connects Alchemy to Cloudflare (browser OAuth once, or set
   `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in `.env`).
2. **Collects config** — dashboard Access emails, worker secrets
   (`GITHUB_TOKEN`, `AI_GATEWAY_TOKEN`, Slack/Telegram/Discord credentials),
   your paid-CLI subscription credentials (Claude, Codex, Cursor, Devin — blank
   keeps the lane dark), feature flags (`SHIBA_*_SUBSCRIPTION`, `AGENT_HARNESS`,
   `AUTOMATIONS_ENABLED`, `MEMORY_ENABLED`), and the agent mailbox address.
3. **Builds and deploys** — `pnpm build` then `alchemy deploy`. Everything in
   `.env` is bound as a secret or var; anything missing there is **removed**
   from the Worker on the next deploy, so `.env` is the source of truth.

## After deploy (printed by the script)

- **Cloudflare Access** — until an Access app covers the hostname, every
  `/api/*` answers 401 `access_not_configured` by design (fail closed).
  Create it at one.dash.cloudflare.com → Access → Applications on
  `app.tryshiba.dev` (or your workers.dev host); `ACCESS_EMAILS` +
  `WORKERS_SUBDOMAIN` in `.env` pick up the audience automatically on redeploy.
- **Custom domain** — Workers → Settings → Domains → Add
  (e.g. `app.tryshiba.dev`); mirror the hostname into `.env` as
  `WORKER_HOSTNAME`.
- **Agent mailbox** — Email Routing → Custom addresses → create
  `dev@tryshiba.dev` (or your `AGENT_MAILBOX`) → route to Worker
  `shiba-ai-coworker`, then register it via `POST /api/mailboxes`. Unregistered
  recipients are rejected by design — register first.
- **Sandbox image** — the deployed Worker pulls the pushed registry image.
  On an arm64 machine: `docker buildx build --platform linux/amd64 -t
  registry.cloudflare.com/<account-id>/shiba-ai-coworker-sandbox-dogfood:boot
  --push apps/backend`. (The `deploy-worker.yml` workflow can build it too.)
- **Chat channels** — Slack via `slack-app-manifest.yaml`; Telegram via
  `setWebhook` to `/api/telegram/webhook` with `TELEGRAM_WEBHOOK_SECRET`;
  Discord via the Interactions Endpoint at `/api/discord/interactions` with
  `DISCORD_PUBLIC_KEY`.
- **Check** — `https://<host>/api/setup/status` after signing in.

## When `alchemy deploy` can't plan (narrow API token)

The Alchemy plan phase reads D1/Vectorize/KV/R2 state; a token scoped for
Workers only gets 401s. Either widen `CLOUDFLARE_API_TOKEN` or deploy the
proven wrangler path: `node scripts/assemble-public.mjs` → copy
`apps/backend/wrangler.jsonc` to a sibling config with `containers[].image`
swapped to the pushed registry ref → strip absolute-URL and `/app*`/`/dashboard*`
rules from `public/_redirects` → `npx wrangler deploy -c <sibling>` → delete
the sibling. `secrets()` can't be pushed by wrangler without `.env` values —
set them with `npx wrangler secret put <NAME>`.

## Rollback

`npx wrangler rollback -c apps/backend/wrangler.jsonc` returns the Worker to
the previous version. Removing a key from `.env` and redeploying removes the
binding; leave subscription flags blank to take a lane dark.
