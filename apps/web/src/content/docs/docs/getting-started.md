---
title: Getting started
description: Install and build the local dashboard and documentation.
---

## Prerequisites

Use **Node.js 22.12.0 or newer** and **pnpm 10.0.0 or newer**. Run commands at the repository root.

For live coding, you also need Cloudflare Workers, Workers AI, Durable Objects and Containers access, a compatible container engine, and a public GitHub repository. Read [Readiness](/docs/readiness/) before provisioning anything.

## Install and verify

~~~sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
~~~

The combined build writes the dashboard to public/ and docs to public/docs/. It does not deploy or publish a PR.

## Preview documentation

~~~sh
pnpm docs:preview
~~~

Open http://localhost:4321/docs/. Production builds include Pagefind search; the docs development server does not.

## Prepare the coding application

The fastest path is the interactive bootstrap:

~~~sh
pnpm run bootstrap
~~~

It checks `wrangler` auth, deploys the Worker and container image, prompts for each secret (skippable), and prints the Slack app manifest import path and the URLs to paste into your Slack app. Afterwards the dashboard's onboarding modal shows live status from `GET /api/setup/status`.

Manual path: copy .dev.vars.example to the ignored .dev.vars file. Set the values described in [Configuration](/docs/configuration/). Public diff-only runs need no GitHub token.

The Vite command, pnpm dev, is **UI-only**, with no Worker API or WebSocket proxy. Use [Local development](/docs/local-development/) for Worker startup. A static page is not evidence that the cloud coding integration works.

After resolving the [readiness blockers](/docs/readiness/), submit a small task against a public test repository you own, review the exact tool input, approve or reject it, and inspect the final transcript and diff. Keep publishing off initially. Run the target repository's checks before adopting any generated changes.



