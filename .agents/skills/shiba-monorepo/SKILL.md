---
name: shiba-monorepo
description: |
  Repo-specific monorepo guidance for shiba-ai-coworker. Covers the three-app
  workspace (backend Worker, frontend dashboard, web docs), the turbo task
  graph, the dual deploy path (alchemy.run.ts primary, wrangler.jsonc rollback),
  what may cross an app boundary, and where a new capability belongs.

  Use when user: adds or changes an app under apps/, touches turbo.json or
  pnpm-workspace.yaml, adds a dependency, changes a binding, migration, or
  env var, edits the Dockerfile or harness catalog, or asks where code should go.
metadata:
  version: 1.0.0
---

# shiba-ai-coworker monorepo

Read `ARCHITECTURE.md` first for the system map. This skill covers **how this
repo is laid out and the rules that keep it coherent.**

## Layout

```
apps/backend     the Cloudflare Worker — ALL logic lives here
  src/index.ts   router: authenticate per surface, then dispatch
  src/harness/   the six agent CLIs (one transport, per-harness shims)
  test/          74 files, colocated as apps/backend/test
apps/frontend    React dashboard (Vite + TanStack Router)
  src/components/  25 views
apps/web         docs + marketing (Astro Starlight)
public/          BUILD OUTPUT — served by the Worker's ASSETS binding
scripts/         ops: setup, docs check, token mint, drift check
```

## The rules that keep this coherent

### 1. Apps do not import each other

There is no cross-app import anywhere, and there should never be one. The three
apps share dependencies through the registry, not through source. If two apps
need the same code, it belongs in a fourth package under `packages/` — a
directory that does not exist yet, so creating it is a deliberate decision, not
a convenience.

**Why:** the backend ships to the edge and has no bundler; a source import from
the frontend would pull Worker-only code into the browser bundle.

### 2. The backend has no `build` task

`apps/backend/package.json` has `dev`, `lint`, `test`, `test:live` — and
deliberately **no `build`**. It ships TypeScript source to the edge. Adding a
build step would break the deploy. The root `build` runs turbo across the two
frontends only.

### 3. Turbo does not cache `test` or `lint`

`turbo.json` sets `cache: false` for both, and only `build` declares real
`outputs`. This is intentional — a stale green test result is worse than a slow
one. Do not "optimize" it.

### 4. Two deploy files, one stack

`alchemy.run.ts` is the primary path (`pnpm deploy`); `wrangler.jsonc` is the
rollback path. **They must declare the same bindings.** After changing either,
run the check — it is already enforced in CI (`.github/workflows/ci.yml`), so
drift fails the build:

```bash
node scripts/check-alchemy-drift.mjs
```

Any change to a binding, a DO class, a migration tag, a container, or an env
var goes in **both**, or CI fails and the next deploy adopts nothing.

### 5. Migrations are append-only

Durable Object classes get a new `new_sqlite_classes` tag per deploy
(`v1`…`v7` in both files). Never edit an existing tag — a live deployment has
already applied it.

### 6. Patches are version-pinned

`patches/brace-expansion@5.0.12.patch` and `patches/chat@4.40.0.patch`. Bumping
either dependency without updating its patch silently drops the patch. The
`overrides` block in `pnpm-workspace.yaml` exists for the same reason.

### 7. The design system is one vocabulary

Tokens are defined in `design.md`. `apps/frontend/src/styles.css` declares the
canonical names (`--paper`, `--card`, `--ink`, `--navy`) with literal colors and
derives local aliases (`--bg`, `--panel`, `--text`, `--accent`) via `var()`.
Dark mode overrides the **canonical** names only. **Read `design.md` before
adding any color.** Never introduce a third name for an existing color.

## Common commands

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build   # the full gate
pnpm -C apps/backend test          # 74 files
pnpm -C apps/backend dev           # wrangler dev, port 8788
pnpm -C apps/frontend dev          # dashboard only
pnpm docs:dev                      # docs only
pnpm deploy                        # alchemy (primary)
pnpm deploy:preview                # plan, do not apply
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc   # needs Docker
```

## Where does a change belong?

| The change | Goes in | Also update |
|---|---|---|
| A new way in (Teams, a webhook) | `apps/backend/src/` + a lane module | `env.ts`, both deploy files, `ARCHITECTURE.md` §2 |
| A new agent CLI | `harness/` + `Dockerfile` + `harness/catalog.ts` | `HARNESS_DEFAULT_MODELS`, egress hosts, image build |
| A new stateful thing | a new `*-do.ts` + a new migration tag | both deploy files, `ARCHITECTURE.md` §4 |
| A new env var | `env.ts` + alchemy `configVars`/`secrets` | wrangler `vars`, `.env.example`, docs |
| A new dashboard view | `apps/frontend/src/components/` | nav rail, `design.md` if it introduces a color |
| A docs page | `apps/web/src/content/docs/` | — |

## Adding a dashboard view

1. Component in `apps/frontend/src/components/`, using canonical color tokens.
2. Register in `AppNavRail.tsx`.
3. Backed by a route in `apps/backend/src/index.ts` — **with its own
   authentication**, following the pattern of the surface it resembles. A new
   ingress surface never inherits another surface's auth.
4. Test alongside the existing `dashboard*.test.ts` files.

## The invariants no change may weaken

These are the repo's security contract (`CLAUDE.md`, `ARCHITECTURE.md` §5). A
refactor that touches any of them is a security change:

1. No sandbox starts without a human approving the **frozen** input.
2. Egress is deny-by-default, narrowed per run to the selected harness + git —
   never the union across harnesses.
3. Git credentials are repo-scoped; `github.com` defaults to refusal.
4. Secrets never reach a container, log, URL, clone string, or UI response.
5. Each ingress surface authenticates by its own mechanism.
