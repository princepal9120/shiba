---
title: Local development
description: Run the dashboard, Worker, docs, and tests without overstating local or cloud evidence.
---

Use Node.js 22.12.0+ and pnpm 10+. From a terminal, clone the repository and install dependencies once:

```sh
git clone https://github.com/princepal9120/ai-intern.git
cd ai-intern
pnpm install
```

## First local run

Start the workspace from the repository root:

```sh
pnpm dev
```

This starts the dashboard (Vite, `http://localhost:5173/app/`), the local Worker (Wrangler, port `8788`), and the docs site (Astro, `http://localhost:4321/`). Keep this terminal open and wait for each service's ready message. Open the dashboard URL to try the UI; use the Astro URL for the docs. The Vite dev server proxies API requests and the `/agents` WebSocket connection to the Worker.

No `.dev.vars` file is needed just to start the UI. To configure optional local integrations, make a private local copy of the example and edit only the values you need:

```sh
cp apps/backend/.dev.vars.example apps/backend/.dev.vars
```

Keep `.dev.vars` local; never commit credentials. Provider keys belong in your AI Gateway BYOK configuration, not in the container. For coding tasks that launch a Sandbox container, start a compatible Docker engine first. Worker AI calls and integrations may also require account configuration and their optional credentials.

If a service fails to start, check its output in the `pnpm dev` terminal. The dashboard can render without a working Worker, but API-backed features will not work; confirm Wrangler is listening on port `8788` and that the Vite proxy can reach it. `pnpm dev` is local development only—it does not deploy anything.

## Docs

```sh
pnpm docs:dev       # docs only, at http://localhost:4321/
pnpm docs:check
pnpm docs:build
pnpm docs:preview   # built site
```

`pnpm dev` already starts the docs site; use `pnpm docs:dev` when you want only Astro. `docs:build` writes `apps/web/dist`. `pnpm build` builds the dashboard into `public`, builds/copies docs into `public/docs`, and runs docs verification. Keep that order: the dashboard build empties its output directory.

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
