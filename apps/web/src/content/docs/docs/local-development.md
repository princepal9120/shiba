---
title: Local development
description: Run the dashboard, Worker, docs, and tests without overstating local or cloud evidence.
---

Use Node.js 22.12.0+ and pnpm 10+. Install from the repository root with `pnpm install`.

## Dashboard and Worker

Start the dashboard and Worker in separate terminals:

```sh
pnpm dev                         # dashboard at http://localhost:5173/app/
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
npx wrangler dev --config apps/backend/wrangler.jsonc --port 8788
```

The Vite server proxies `/api` and WebSocket `/agents` requests to the Worker at port 8788. Without the Worker, the dashboard is UI-only and backend requests fail. Wrangler output gives the Worker URL. The configured Sandbox container may require a running compatible Docker engine; Cloudflare bindings, gateway calls, and network-dependent integrations may also need account configuration.

## Docs

```sh
pnpm docs:dev       # http://localhost:4321/docs/
pnpm docs:check
pnpm docs:build
pnpm docs:preview   # built site
```

`docs:build` writes `apps/web/dist`. `pnpm build` builds the dashboard into `public`, builds/copies docs into `public/docs`, and runs docs verification. Keep that order: the dashboard build empties its output directory.

## Local verification versus live behavior

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

Unit tests primarily use fakes and do not prove provider inference or cloud behavior. The dated 2026-09-19 local end-to-end record covers OpenCode under local `wrangler dev` plus a real Docker container, but the provider returned 401 and no model inference succeeded. The latest 2026-09-24 `VERIFICATION.md` records no cloud end-to-end run and deployment pending. Do not claim live model execution, browser interactions, or deployment success from static builds, mocked tests, or a dry run.
