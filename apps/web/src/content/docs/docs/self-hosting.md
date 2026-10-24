---
title: Self-hosting on Cloudflare
description: Deploy Shiba into your own Cloudflare account with bring-your-own model keys, one deploy tool per environment, and no secret drift between Alchemy and wrangler.
---

Shiba is **AGPL-3.0-only** software you run in **your** Cloudflare account. Compute, sandboxes, and stored run data stay on infrastructure you control. Model spend goes to **your** AI Gateway BYOK configuration (or your subscription lanes), not a vendor credit pool.

This page is the operator guide for a fresh account. It does not deploy anything from the docs site itself — run commands on a machine where you are signed in to Cloudflare (`npx wrangler whoami`) and where Docker can build the Sandbox image.

## Prerequisites

| Requirement | Why |
| --- | --- |
| **Node.js 22.13+** and **pnpm 10+** | Monorepo toolchain (`package.json` `engines`) |
| **Workers Paid** plan | Containers, Durable Objects, and Sandbox usage |
| **Docker-compatible engine** | `wrangler dev` / deploy builds the pinned `apps/backend/Dockerfile` image |
| **Cloudflare products enabled** | Workers, Durable Objects, **Containers**, Workers AI, KV, R2, D1, Vectorize, Browser Rendering (optional screenshots), Email Sending (optional mailbox) |
| **AI Gateway** with **BYOK** | Provider keys live in the gateway; the sandbox never receives real provider credentials |

Honest ceiling: Cloudflare Containers default to **`standard-4` (4 vCPU / 12 GiB)** — see [Containers limits](https://developers.cloudflare.com/containers/platform/limits/). This is not a hosted “128 GB machine” product; size tasks accordingly.

## Cloudflare account setup (first time)

1. **Sign in** — `npx wrangler login` (OAuth) or set `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in a gitignored root `.env` for Alchemy.
2. **Create backing resources** on a **new** account (replace names/IDs in `apps/backend/wrangler.jsonc` with yours):

   ```sh
   npx wrangler r2 bucket create shiba-attachments
   npx wrangler kv namespace create AGENT_TOKENS
   npx wrangler d1 create shiba-audit
   npx wrangler vectorize create shiba-memory --dimensions=768 --metric=cosine
   npx wrangler vectorize create-metadata-index shiba-memory --property-name=agent --type=string
   ```

3. **Paste resource IDs** into `apps/backend/wrangler.jsonc` (`database_id`, KV `id`, Vectorize index name, R2 bucket). Keep `alchemy.run.ts` in sync — run `node scripts/check-alchemy-drift.mjs` after edits.
4. **AI Gateway** — in the dashboard, open AI Gateway → your gateway (default id `default` matches `GATEWAY_ID`) → **Provider keys** → add Google / Anthropic / OpenAI (or the provider your harness uses). This is the BYOK path; do not put those keys in the repo or in the container.
5. **Access (recommended for any public hostname)** — Cloudflare One → Access → Applications. Allow only your team’s emails. You will bind `ACCESS_AUD` and set `REQUIRE_ACCESS=1` as secrets/vars on deploy. Machine callbacks (`/api/github/webhook`, `/api/slack/*`, `/mcp`, …) use narrow bypass rules authenticated inside the Worker — see [Security](/docs/security/).

Local proof before spending quota: run **`pnpm shiba dev`** (or `bash scripts/dev.sh`) — see [Local quickstart](/docs/local-development/#worker-and-sandbox-quickstart). Optional harness: `.cursor/skills/verify-shiba` (approval → sandbox → optional PR/review when configured).

## Secrets and configuration map

Non-secret defaults (`CODING_MODEL`, `GATEWAY_ID`, harness flags, …) live in **`wrangler.jsonc` vars** and the matching block in **`alchemy.run.ts`**.

**Credentials** belong in exactly **one** deploy source of truth per environment:

| Path | Where secrets live | Risk if mixed |
| --- | --- | --- |
| **Alchemy** (`pnpm run bootstrap`, `pnpm run deploy:alchemy`) | Root **`.env`** (from `.env.schema`; `pnpm env:load` validates) | Alchemy **replaces** Worker secrets on every deploy. A key set only via `wrangler secret put` but missing from `.env` is **removed** on the next Alchemy deploy. |
| **Wrangler** (`npx wrangler deploy --config apps/backend/wrangler.jsonc`) | `npx wrangler secret put <NAME>` (and optional local `apps/backend/.dev.vars` for `wrangler dev` only) | Secrets do not auto-sync to `.env`. If you later run Alchemy against the same Worker without copying values into `.env`, you can wipe production secrets. |

**Rule: pick one tool per stage.** Production on Alchemy → always edit `.env`, never rely on orphan `wrangler secret put` values. Production on wrangler → do not run `deploy:alchemy` against that Worker name unless you intentionally migrate and reconcile secrets first.

### Secret checklist (typical coding + PR + review install)

Set only what you use. Names must match `apps/backend/src/env.ts` and `apps/backend/.dev.vars.example` (checked by `node scripts/check-dev-vars-example.mjs`).

| Order | Name | Purpose |
| --- | --- | --- |
| 1 | `ACCESS_AUD` | Access JWT audience; pair with `REQUIRE_ACCESS=1` on live hosts |
| 2 | `GITHUB_TOKEN` | Fine-grained PAT: target repo, Contents + Pull requests (Worker-side publish + scoped git egress) |
| 3 | `GITHUB_WEBHOOK_SECRET` | HMAC for automation webhooks (optional) |
| 4 | `AI_GATEWAY_TOKEN` | Only if your gateway requires authenticated requests |
| 5 | `DASHBOARD_APPROVERS` | Comma-separated emails allowed to resolve shared approvals |
| 6 | `BETTER_AUTH_SECRET` | Optional dashboard login (≥32 chars); unset keeps Access-only gate |
| 7 | Integration secrets | Slack / Telegram / Discord / `TRIGGER_TOKEN` as needed |

Provider keys for OpenCode / Claude Code / Codex / Grok → **AI Gateway BYOK**, not Worker secrets.

Subscription lanes (`CLAUDE_SUBSCRIPTION_TOKEN`, `CODEX_SUBSCRIPTION_AUTH_JSON`, …) are optional and gated by `SHIBA_*_SUBSCRIPTION` vars in `wrangler.jsonc`.

Local copy template (`pnpm shiba dev` creates this file and mints safe local secrets without overwriting yours):

```sh
pnpm shiba dev          # or: bash scripts/dev.sh
# Edit apps/backend/.dev.vars — add GITHUB_TOKEN and gateway/BYOK as needed.
node scripts/check-dev-vars-example.mjs
node scripts/validate-credentials.mjs --offline
```

## Choose one deploy path

### Path A — Alchemy (recommended for first production)

Interactive bootstrap provisions the Worker, Durable Objects, container image binding, KV/R2/D1/Vectorize, and can create Access apps when `ACCESS_EMAILS` + `WORKERS_SUBDOMAIN` are set.

```sh
pnpm install
pnpm typecheck && pnpm test && pnpm build
pnpm run bootstrap   # writes .env, builds, alchemy deploy
```

Re-deploy: `pnpm run deploy:alchemy`. Preview plan: `pnpm deploy:preview`. Details: [Launch](/docs/launch/) and [Deployment](/docs/deployment/).

After deploy:

```sh
npx wrangler d1 migrations apply shiba-audit --remote --config apps/backend/wrangler.jsonc
```

Open `https://<your-host>/app/`, sign in via Access, check `/api/setup/status`.

### Path B — Wrangler only (rollback or wrangler-first operators)

Same bindings as `wrangler.jsonc`; **does not** create Access applications — configure Access manually before exposing the hostname.

```sh
pnpm install && pnpm build
# Secrets (repeat per name from the checklist):
npx wrangler secret put GITHUB_TOKEN --config apps/backend/wrangler.jsonc
npx wrangler secret put ACCESS_AUD --config apps/backend/wrangler.jsonc
# …
npx wrangler d1 migrations apply shiba-audit --remote --config apps/backend/wrangler.jsonc
npx wrangler deploy --config apps/backend/wrangler.jsonc
```

Dry-run packaging locally (no deploy): `npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc` (requires Docker).

**Avoid secret drift:** if this Worker was ever deployed with Alchemy, export every secret from dashboard or `.env` before switching paths. Going forward, either (a) stay on wrangler and never run `deploy:alchemy` on that name, or (b) move back to Alchemy and treat `.env` as the only secret store.

### Static marketing + docs (optional second hostname)

The Worker serves the dashboard from **`app-public/`** (assembled by `pnpm build`). The combined **`public/`** tree (landing + `/docs/`) is for Cloudflare Pages (`tryshiba.dev` style):

```sh
pnpm build
pnpm exec wrangler pages deploy public --project-name shiba --branch main
```

Redirect `/app*` from Pages to your Worker host via `apps/web/public/_redirects`.

## Post-deploy verification

1. `/api/setup/status` returns JSON when the API is up (not SPA HTML).
2. Submit a throwaway task on a test repo with publishing disabled; approve; confirm a single sandbox container and an honest diff.
3. When ready, enable PR + review and record evidence in `VERIFICATION.md` (see [Readiness](/docs/readiness/)).

## Related pages

- [Configuration & secrets](/docs/configuration/)
- [Local development](/docs/local-development/)
- [Shiba vs hosted alternatives](/docs/hosted-alternatives/) (neutral comparison)
- [Security](/docs/security/)
