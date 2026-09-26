---
title: Onboarding and setup
description: Prepare a local checkout and understand what has—and has not—been verified for live use.
---

This guide describes the current repository setup, not a completed cloud acceptance run. The latest dated record in `VERIFICATION.md` is 2026-09-24: local checks pass, but cloud deployment is pending. On 2026-09-19, OpenCode was exercised end to end with local `wrangler dev` and OrbStack; the model request returned 401, so inference was not verified. No cloud live run is recorded. Treat all harnesses and deployment instructions below as implementation/setup guidance, not proof of production readiness. See [Readiness](/docs/readiness/).

## Local prerequisites

- Node.js 22.12.0 or newer and pnpm 10 or newer (see root `package.json`).
- Docker-compatible engine for building/running the configured Sandbox image.
- Cloudflare account and access to the Workers, Durable Objects, Workers AI, Containers/Sandbox and other configured resources for deployment. Eligibility, limits, and pricing vary; check current Cloudflare documentation.

From the repository root, install and run the local checks:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
```

Passing these commands verifies local code/build behavior only. Unit tests use fakes; they do not prove a provider inference, Cloudflare deployment, or cloud container run.

## Account-owned deployment setup

The bootstrap command is `pnpm run bootstrap` (implemented by `scripts/setup.mjs`). It requires Docker running and connects Alchemy to Cloudflare by browser OAuth, or accepts Cloudflare API credentials in `.env`. It collects Access owner emails and the Workers subdomain, prompts for optional secrets, writes `.env` with mode 0600, then builds and runs `alchemy deploy`. Re-running uses the saved answers. Inspect the script and `alchemy.run.ts` before use: deploy changes your Cloudflare account. Do not assume bootstrap skipped or incomplete credentials result in a usable service.

The deploy config creates hostname-scoped Access applications when `ACCESS_EMAILS` and `WORKERS_SUBDOMAIN` are supplied. Live stages set `REQUIRE_ACCESS`; missing Access configuration therefore fails closed unless an externally managed Access app protects the hostname. Machine callbacks have narrowly scoped bypasses and authenticate in the Worker. Verify the actual hostname and paths after deployment; do not expose an unprotected Worker origin.

AI Gateway access must be configured for the selected account-owned gateway. Provider keys belong in its supported credential configuration, not in the container. `AI_GATEWAY_TOKEN` is an optional Worker secret used for authenticated gateway requests; a local test without valid gateway credentials returned 401. Do not infer successful model execution from setup status or a build.

## First validation

Before using real repositories, complete the [readiness checklist](/docs/readiness/) and use an isolated public test repository. Start with a diff-only task and publishing disabled. Inspect the approved task, run result, and diff, then run the target repository's checks yourself. A completed cloud acceptance run exists only when a dated result is added to `VERIFICATION.md`.

### Evidence levels

- **Implemented:** behavior exists in current source/configuration.
- **Unit-tested:** tests exercise that behavior, generally with fakes.
- **Locally exercised:** the dated 2026-09-19 record covers OpenCode container startup, repository clone, egress routing, and error cleanup under local `wrangler dev`; provider inference returned 401.
- **Cloud-live:** no end-to-end cloud run is recorded as of the 2026-09-24 verification entry.

For Slack app setup (scopes, endpoints, approver allowlist) see [Slack Integration](/docs/slack/). For the full runtime environment variable reference see [Configuration](/docs/configuration/).

Claude Code, Codex, and Devin are implemented and have unit-tested harness/configuration paths. Their successful execution against live provider services is not established by the dated verification record. OpenCode is the only harness exercised in the recorded local end-to-end run, and that run did not complete model inference.
