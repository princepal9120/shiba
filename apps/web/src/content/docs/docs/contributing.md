---
title: Contributing
description: Local verification, documentation contracts, and contribution boundaries.
sidebar:
  order: 12
---

Start with `spec/GOAL.md` for the product contract and
`spec/HOMEPAGE-PLAN.md` for the dashboard and documentation scope.
Describe a proposed change separately from behavior already implemented.

## Verify locally

Use the Node and pnpm versions declared in `package.json`:
Node 22.12.0 or newer and pnpm 10.0.0 or newer.
Run these commands from the repository root:

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
```

The script definitions live in `package.json`. Tests using fakes do not
establish live provider or container behavior. Report the actual outcome of
each command, including environmental failures or checks not run.
A dry run is not a deployment. See [Local development](/docs/local-development/).

## Documentation changes

Edit pages under `apps/web/src/content/docs/`. Keep `title` and `description`
frontmatter, descriptive headings, and links using the `/docs/` base.
Starlight supplies navigation and search; avoid duplicating its interface.
Source: `apps/web/astro.config.mjs`.

Write technical claims from `apps/backend/src/`, `apps/backend/wrangler.jsonc`, and the installed
configuration rather than copying README assumptions. Cite relevant source
files or symbols. When source and the goal differ, label **Current behavior
(as implemented)** and **Specification target (GOAL)** explicitly.

The combined build builds the dashboard first, then documentation, copies
the documentation output into `public/docs`, and verifies the assembled site.
Do not reverse that order: Vite empties `public` before its build.
Source: root `package.json`, `apps/frontend/vite.config.ts`, and `scripts/copy-docs.mjs`.

## Review and publication

Never include secrets or private run transcripts in docs, test fixtures,
screenshots, or an issue. Review generated code and run its repository's
checks independently. See [Security](/docs/security/).

Deployment, pushing commits, and opening pull requests are external actions;
local verification does not authorize them. State what was tested without
claiming live acceptance from a static build.
The project declares the MIT license in `package.json` and `LICENSE`.

## Release hygiene

These versions are pinned because they couple to runtime behavior. Bumping any
of them requires re-running the live acceptance checklist (T10).

| Package | Version | Why it matters |
|---|---|---|
| `opencode-ai` | `1.18.31` | `parseOpencodeEvent` couples to the JSON event format. A stream-format change breaks progress parsing silently. |
| `@cloudflare/sandbox` | `0.12.9` | Must match the base image tag in `Dockerfile`. The `interceptHttps` + `outboundByHost` mechanism is the "no credentials in the container" guarantee. |
| `CODING_MODEL` | `google/gemini-3.5-flash-lite` | Model ids retire. A retired model fails silently at run time. |

`apps/backend/src/index.ts` throws on first request if `CODING_MODEL` is in the retired-id deny list.

