---
title: Deployment preparation
description: Prepare an account-owned installation without confusing local validation with live acceptance.
---

## Current verification status

The latest dated entry in `VERIFICATION.md` (2026-09-24) reports local checks passing, while Alchemy deployment remains pending Cloudflare OAuth/configuration. No end-to-end cloud run is recorded. The 2026-09-19 OpenCode `wrangler dev` run locally started a Docker container, cloned a public repo and routed provider egress, but the model request returned 401; model inference was not verified. Do not call the project cloud-live or production-ready on this evidence. See [Readiness](/docs/readiness/).

## Local preparation

Requires Node.js 22.12.0+, pnpm 10+, and a running Docker-compatible engine for the configured container image. In the repository root:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

The dry run packages/validates configuration; it does not deploy. `VERIFICATION.md` records a prior dry run as blocked by Docker availability (with a no-container rollout variant passing), so rerun it in your environment and report the actual result.

## Account configuration and deployment

The supported bootstrap is `pnpm run bootstrap`, not a sequence of Wrangler secret commands. `scripts/setup.mjs` checks Docker, connects Alchemy through Cloudflare OAuth (or `.env` API credentials), collects `ACCESS_EMAILS` and `WORKERS_SUBDOMAIN`, prompts for optional secrets, writes `.env`, builds, and runs `alchemy deploy`. Review `.env` and `alchemy.run.ts`; Alchemy treats the values present in `.env` as its deployment secret/config source. This command changes your Cloudflare account.

For a manual deployment, first configure Alchemy credentials and required account resources as defined by `alchemy.run.ts`; then `pnpm build` and `npx alchemy deploy` (or run the bootstrap). Do not substitute `wrangler deploy` for this deployment path without validating that it provisions the Alchemy-managed resources. The checked-in Wrangler config remains useful for local `wrangler dev` and dry-run checks.

Configure `ACCESS_EMAILS` and `WORKERS_SUBDOMAIN` for the managed hostname-scoped Access apps. A live stage sets `REQUIRE_ACCESS=1`; if managed Access is absent, requests fail closed unless another Access application fronts the Worker. Machine callback paths bypass Access only where configured, and are authenticated by Worker-side signatures/tokens/secrets. Verify every reachable hostname (including `workers.dev`) and callback path after deployment. See [Security](/docs/security/).

Configure the account-owned AI Gateway and its provider credentials separately. The Worker uses its AI binding and `GATEWAY_ID`; `AI_GATEWAY_TOKEN` is an optional Worker secret for authenticated gateway access. The container receives dummy provider credentials. Valid provider access is required to establish inference; a successful build, setup-status response, or local egress rewrite is not inference evidence. Do not place real provider credentials in the container or repository.

## Acceptance and rollback

Use an isolated test deployment and throwaway public repository. Keep pull-request publishing disabled initially; verify approval, execution, result and diff, and run the repository checks independently. Record date, environment, harness, model outcome, and failures in `VERIFICATION.md`. Until a cloud run succeeds, distinguish local/unit evidence from cloud-live behavior.

For updates, preserve the prior revision and lockfile, rerun local checks, and review Durable Object migrations. Rolling back code does not roll back Durable Object data or undo repository branches/PRs. Avoid deleting runtime data during routine updates.
