---
title: Deployment preparation
description: Prepare an account-owned installation and verify it before live use.
---

## Readiness first

**Do not treat this as production until T10 is dated in `VERIFICATION.md`.** Put Cloudflare Access on the Worker, with a bypass only for the signature-authenticated callbacks: `/api/slack/events`, `/api/slack/command`, `/api/slack/interact`, and `/api/github/webhook`. Read [Security](/docs/security/) and [Readiness](/docs/readiness/) first.

Live operation requires a Cloudflare account with Workers, Durable Objects, Workers AI, and Containers/Sandbox access. Check current eligibility, quotas, and pricing in the [Containers](https://developers.cloudflare.com/containers/) and [Sandbox](https://developers.cloudflare.com/sandbox/) documentation. No provisioning time is guaranteed.

## AI Gateway setup

1. Create or select an account-owned AI Gateway. Its ID is GATEWAY_ID.
2. Review the [Google AI Studio provider guide](https://developers.cloudflare.com/ai-gateway/usage/providers/google-ai-studio/) and configure supported stored BYOK credentials or Unified Billing.
3. The current internal helper uses AI.gateway(GATEWAY_ID).run with the native Google endpoint and provider-native JSON. It does not use CF_ACCOUNT_ID or AI_GATEWAY_TOKEN. The Worker AI binding supplies account access.
4. Keep real provider credentials outside the container. OpenCode uses a dummy Google key.
5. Confirm a live coding run against a throwaway repo before claiming it works. Provider keys stay in AI Gateway BYOK; the container never sees them.

For direct HTTP integrations outside this code, authenticated gateways use cf-aig-authorization, not an interchangeable generic Authorization header. Consult [gateway authentication](https://developers.cloudflare.com/ai-gateway/configuration/authentication/) and [stored BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/). Do not copy obsolete token-proxy instructions into this implementation.

## Prepare locally

~~~sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
~~~

The dry run is packaging validation, not deployment. Record missing Docker, image, or runtime limitations honestly. Building the docs does not require live coding credentials.

## Deploy after blockers are resolved

~~~sh
npx wrangler login
# Configure optional GitHub secrets described in Configuration.
pnpm build
pnpm deploy
~~~

These commands change your Cloudflare account. `pnpm deploy` does not automatically build assets, so run `pnpm build` first. Wrangler uses `./Dockerfile` for the image and `./public` for assets; the dashboard is at `/app/` and docs are at `/docs/`. Static missing paths use `404-page` rather than an SPA catch-all.

Protect every reachable hostname, including alternate workers.dev routes, with reviewed authentication. Browser login alone does not authenticate service callbacks. Never expose the Worker origin outside Access. Complete the [acceptance procedure](/docs/readiness/) in an isolated test installation before inviting users.

## Updates and recovery

Preserve the previous revision and lockfile. Re-run checks, review Durable Object migrations, and validate in a test installation. Code rollback does not automatically restore Durable Object data or undo GitHub branches/PRs. Avoid deleting runtime data as part of a routine docs update.

