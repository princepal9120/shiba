---
title: Nimbus Docs CLI
description: Cloudflare's Nimbus Docs CLI as an optional external tool for linting and maintaining this repository's documentation.
---

The AI Intern documentation site is built with **Astro Starlight**
(`@astrojs/starlight` in `web/astro.config.mjs`), not Nimbus. This page
describes **Cloudflare's Nimbus Docs CLI** (`@cloudflare/nimbus-docs`) as an
optional, external documentation-maintenance tool under evaluation for use
with this repository's content.

Nimbus is **not installed** in this repo: there is no `nimbus.json` and no
`@cloudflare/nimbus-docs` dependency in `package.json`. Run it on demand with
`pnpm dlx`, or add it as a dev dependency first:

~~~sh
# Run without installing
pnpm dlx @cloudflare/nimbus-docs <command> [flags]

# Or install into the docs workspace, then use pnpm exec
pnpm add -D @cloudflare/nimbus-docs
pnpm exec nimbus-docs <command> [flags]
~~~

Official reference: [https://nimbus-docs.com/cli/](https://nimbus-docs.com/cli/)
Upstream source: [github.com/cloudflare/nimbus](https://github.com/cloudflare/nimbus)

## Command reference

| Command | Purpose |
| --- | --- |
| `nimbus-docs list` | List installable components, utilities, and features in the registry |
| `nimbus-docs add <slug>` | Install components or print feature recipes for coding agents |
| `nimbus-docs init` | Create a `nimbus.json` provenance record (none exists in this repo yet) |
| `nimbus-docs check` | Preflight validation across environment, structure, authoring, types, and migrations |
| `nimbus-docs migrate` | Plan and apply breaking-change migrations across Nimbus versions |
| `nimbus-docs outdated` | Audit package APIs, starter files, and registry components against upstream |
| `nimbus-docs diff [file]` | Inspect and optionally apply upstream starter template diffs |
| `nimbus-docs lint` | Lint `.md` and `.mdx` content for authoring-quality diagnostics |

---

## Provenance with `nimbus-docs init`

Nimbus tracks a scaffolding baseline in a `nimbus.json` file. This repo does
not commit one today; running `init` would create it:

~~~sh
pnpm dlx @cloudflare/nimbus-docs init
~~~

Several other commands (`check`, `migrate`, `diff`, `outdated`) compare
against the version recorded in `nimbus.json`, so `init` is the usual first
step before adopting them.

---

## Preflight verification: `nimbus-docs check`

Validates a documentation setup without triggering a full build:

~~~sh
pnpm dlx @cloudflare/nimbus-docs check
pnpm dlx @cloudflare/nimbus-docs check --json
~~~

The checks cover five scopes: environment and dependency declarations,
project structure, migration baseline versus installed version, frontmatter
and authoring rules, and TypeScript diagnostics. Pass `--fix` to apply safe
automatic remediations.

Note: some structure checks assume a Nimbus-scaffolded project layout. This
repo's Starlight site keeps its content in `web/src/content/docs/` and may
report structure findings that do not apply.

---

## Linting content: `nimbus-docs lint`

The most directly useful command for this repo: it walks documentation
content and enforces authoring standards. This repo's docs live in
`web/src/content/docs/` (see `web/astro.config.mjs`), so run it from the
`web/` workspace:

~~~sh
pnpm dlx @cloudflare/nimbus-docs lint
pnpm dlx @cloudflare/nimbus-docs lint --fix
pnpm dlx @cloudflare/nimbus-docs lint --rule=nimbus/single-h1
~~~

Supported flags:

- `--format=json`: Emits machine-readable diagnostics for CI or agent workflows.
- `--fix`: Automatically corrects fixable formatting or frontmatter discrepancies.
- `--quiet`: Suppresses warnings and only reports errors.

---

## Keeping up to date

If Nimbus is adopted, three commands coordinate upstream changes:

### `nimbus-docs migrate`

Analyzes declared breaking changes between the recorded
`lastReviewedNimbusVersion` in `nimbus.json` and the installed package
version:

~~~sh
pnpm dlx @cloudflare/nimbus-docs migrate --dry-run
pnpm dlx @cloudflare/nimbus-docs migrate --yes
~~~

### `nimbus-docs outdated`

Audits what has changed upstream across package APIs, scaffolded starter
files, and registry components:

~~~sh
pnpm dlx @cloudflare/nimbus-docs outdated
pnpm dlx @cloudflare/nimbus-docs outdated --json
~~~

### `nimbus-docs diff`

Shows line-by-line differences between user-owned starter files and the
upstream template release tag, with `--apply` to adopt them.

---

## Installing components: `nimbus-docs add`

Nimbus operates on a copy-into-repo model rather than closed npm
dependencies: `add <slug>` copies component source into the project and
updates `package.json` dependencies. Use `--overwrite` to replace local files
with the upstream registry version, and `--print` on feature recipes to emit
markdown instructions suitable for piping to a coding agent.

Because this repo is not Nimbus-scaffolded, treat `add` output as a source of
components to adapt into `web/src/` rather than a drop-in installer — verify
target paths before applying.
