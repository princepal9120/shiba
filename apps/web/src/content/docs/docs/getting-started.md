---
title: Getting started
description: Install and validate the local project, then review account deployment requirements.
---

## Prerequisites

Use Node.js 22.12.0 or newer and pnpm 10 or newer. Run commands from the repository root. For local container runs or account deployment, also configure a Docker-compatible engine and the Cloudflare resources/credentials required by the deployment. Read [Readiness](/docs/readiness/) before provisioning.

## Install and check locally

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
```

The combined build assembles the dashboard and docs in `public/`; it does not deploy or publish a pull request. Tests with fakes are unit evidence only.

## Preview documentation

```sh
pnpm docs:preview
```

Open `http://localhost:4321/docs/`. Production builds include generated Pagefind search; the docs development server does not.

## Prepare an account deployment

`pnpm run bootstrap` uses `scripts/setup.mjs` and Alchemy. It requires Docker, Cloudflare OAuth/profile setup (or API credentials in `.env`), prompts for Access emails, the Workers subdomain, and optional secrets, then builds and runs `alchemy deploy`. This is a real account-changing deployment command, not a local test. Review [Deployment](/docs/deployment/) and [Configuration](/docs/configuration/) first.

For a first local run, `pnpm dev` starts the dashboard, Wrangler Worker, and docs site together; API and WebSocket requests are proxied to the Worker. Open `http://localhost:5173/app/` for the dashboard and `http://localhost:4321/` for docs. See [Local development](/docs/local-development/) for first-run steps and prerequisites such as Docker for Sandbox tasks.

The current dated verification reports local checks passing but no cloud end-to-end run. OpenCode has a recorded local container exercise; its model request returned 401. Do not infer working cloud coding or inference from a static page, setup status, or local unit tests. After resolving readiness blockers, use an isolated deployment and public test repository, keep publishing off, inspect the approval/result/diff, and record actual outcomes in `VERIFICATION.md`.
