---
title: Local development
description: UI, docs, tests, and the distinction between local builds and live integration.
---

Use Node.js **22.12.0 or newer** and pnpm **10.0.0 or newer**. Install dependencies with `pnpm install`.

## Dashboard only

```sh
pnpm dev
```

Vite serves the dashboard at `http://localhost:5173`. It does not start the Worker and has no API/WebSocket proxy configured. Connection and run-fetch errors are expected in this UI-only mode. This is not a working local coding backend.

## Worker and built assets

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
pnpm build
npx wrangler dev --config apps/backend/wrangler.jsonc
```

Use the URL printed by Wrangler (normally port 8787). A compatible local Docker engine is required by the container configuration; startup itself may fail without it. Cloudflare bindings and model calls can also require account configuration and network access.

The sandbox talks to GitHub and the model provider host; Sandbox egress intercepts those hosts. There is no Worker callback URL. Do not expose an unauthenticated tunnel. Unit tests use fakes and need no container or cloud account.

## Documentation

```sh
pnpm docs:dev       # http://localhost:4321/docs/
pnpm docs:check
pnpm docs:build
pnpm docs:preview   # built site; Pagefind search is available here
```

`docs:build` writes `docs/dist`. `pnpm build` first builds the dashboard into `public`, then builds and copies docs into `public/docs`, then checks local links, anchors, and search artifacts. This order prevents Vite from deleting the documentation output.

## Verification

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

Do not claim real model execution, browser interactions, or deployment success from a static build or mocked unit tests.

