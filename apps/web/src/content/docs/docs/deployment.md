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

## First Alchemy deployment

The supported first-deploy path is the interactive bootstrap. It provisions Cloudflare resources and changes your account—this is not a local preview:

1. Install dependencies and start a compatible Docker engine (Docker Desktop or OrbStack). The configured Sandbox image needs Docker to build.
2. From the repository root, run:

   ```sh
   pnpm install
   pnpm run bootstrap
   ```

3. If Alchemy is not already authenticated, the bootstrap opens Cloudflare OAuth. Alternatively, set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the ignored root `.env` file before rerunning it. Use an API token with the Cloudflare permissions needed for the resources in `alchemy.run.ts`; do not paste credentials into source files or commit `.env`.
4. Enter the email addresses allowed to sign in (`ACCESS_EMAILS`) and your account’s `workers.dev` subdomain (`WORKERS_SUBDOMAIN`). The script prompts for optional integration secrets; leave unused ones blank. It saves the answers in `.env` with owner-only permissions, builds the app, and runs `npx alchemy deploy`.
5. Open `https://shiba-ai-coworker.<your-subdomain>.workers.dev/app/`, sign in with an allowed email, then check `/api/setup/status` and complete the dashboard’s setup checks.

`ACCESS_EMAILS` and `WORKERS_SUBDOMAIN` are important for a live deployment: they let Alchemy create hostname-scoped Cloudflare Access applications. Live stages set `REQUIRE_ACCESS=1`; if managed Access is not created, the dashboard/API will return 401 unless another Access application already protects the Worker. Do not publish or share the `workers.dev` URL until you have verified the Access policy and machine-callback exceptions. See [Security](/docs/security/).

### Manual Alchemy commands

If you have already configured Cloudflare/Alchemy authentication and `.env`, the equivalent manual flow is:

```sh
pnpm build
npx alchemy deploy
```

`pnpm deploy` combines those two commands. `alchemy.run.ts` reads the root `.env`, defines the Worker, Sandbox container, Durable Objects, KV/R2/D1/Vectorize, email, and optional Access resources, and binds only the explicitly supported secrets. The default Alchemy state is local filesystem state. The optional Cloudflare State Store requires a separate one-time provider bootstrap; see the comments in `alchemy.run.ts` before changing `ALCHEMY_STATE_BACKEND`.

The live stage uses the stable production resource names. For an isolated test deployment, set `ALCHEMY_STAGE` (for example, `ALCHEMY_STAGE=test-preview npx alchemy deploy`); the Worker/container/storage names are suffixed. Select the stage through `ALCHEMY_STAGE` only—do not pass a conflicting `--stage` flag. Test stages do not create the managed Access apps, so use only disposable data and do not expose a test Worker publicly.

Do not substitute `wrangler deploy` for this deployment path: it may not provision the Alchemy-managed resources. The checked-in Wrangler config remains useful for local `wrangler dev` and dry-run checks. The Worker uses its AI binding and `GATEWAY_ID`; add model-provider keys to your own AI Gateway BYOK configuration. Provider keys must never be placed in the container or committed to the repository.

Configure the account-owned AI Gateway and its provider credentials separately. The Worker uses its AI binding and `GATEWAY_ID`; `AI_GATEWAY_TOKEN` is an optional Worker secret for authenticated gateway access. The container receives dummy provider credentials. Valid provider access is required to establish inference; a successful build, setup-status response, or local egress rewrite is not inference evidence. Do not place real provider credentials in the container or repository.

## Acceptance and rollback

Use an isolated test deployment and throwaway public repository. Keep pull-request publishing disabled initially; verify approval, execution, result and diff, and run the repository checks independently. Record date, environment, harness, model outcome, and failures in `VERIFICATION.md`. Until a cloud run succeeds, distinguish local/unit evidence from cloud-live behavior.

For updates, preserve the prior revision and lockfile, rerun local checks, and review Durable Object migrations. Rolling back code does not roll back Durable Object data or undo repository branches/PRs. Avoid deleting runtime data during routine updates.
