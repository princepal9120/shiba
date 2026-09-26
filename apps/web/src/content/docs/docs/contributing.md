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

Write technical claims from `apps/backend/src/`, `apps/backend/wrangler.jsonc`, `apps/backend/Dockerfile`, and installed configuration rather than copying README assumptions. Cite relevant source files or symbols. When source and the goal differ, label **Current behavior (as implemented)** and **Specification target (GOAL)** explicitly. Distinguish implementation, unit tests (often fake-backed), local end-to-end exercises, and successful cloud-live evidence; cite the dated `VERIFICATION.md` entry. Its 2026-09-24 summary has no cloud end-to-end run. The 2026-09-19 local OpenCode run ended with a 401 provider response, not successful inference.

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
The project declares AGPL-3.0-only in `package.json` and `LICENSE`.

## Release hygiene

These versions are pinned because they couple to runtime behavior. Bumping any
of them requires re-running the live acceptance checklist (T10).

| Package | Version | Why it matters |
|---|---|---|
| `opencode-ai` | `1.18.31` | Pinned in `Dockerfile`; event parsing depends on the CLI stream format. |
| `@cloudflare/sandbox` | `0.12.9` | Must match the base image tag in `Dockerfile`; verify the SDK egress behavior and credential boundary rather than asserting an absolute isolation guarantee. |
| `@anthropic-ai/claude-code` | `2.1.277` | Pinned image CLI; unit-tested config/argv/parser does not establish live API execution. |
| `@openai/codex` | `0.155.0` | Pinned image CLI; unit-tested config/argv/parser does not establish live API execution. |
| Devin CLI | `3000.10.31` | Checksum-pinned image binary; uses `DEVIN_API_KEY` via Worker egress, not AI Gateway BYOK. |
| `CODING_MODEL` | `google/gemini-3.5-flash-lite` | Default only; model identifiers can change availability. `assertLiveCodingModel` rejects known retired IDs on requests. |

All four harnesses are present in current source and image configuration; only OpenCode has a dated local end-to-end exercise, and no cloud end-to-end run is recorded. Keep this distinction current when updating documentation.
