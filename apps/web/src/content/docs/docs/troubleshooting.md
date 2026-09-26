---
title: Troubleshooting
description: Diagnose local builds and distinguish tested behavior from live integration.
---

| Symptom | Check or action |
| --- | --- |
| Node/pnpm engine error | Use Node 22.12.0+ and pnpm 10+; run `pnpm install` from the repository root |
| Missing package export after partial install | Reinstall locked dependencies with `pnpm install`; do not patch `node_modules` |
| Unknown script | Run from repository root and inspect `package.json` |
| Docs search absent in dev | Run `pnpm docs:preview` against the built site; Pagefind search is generated for the production build |
| Docs 404 or stale output | Run the combined `pnpm build`; it assembles dashboard and docs output in order |
| Dashboard cannot reach backend | `pnpm dev` is dashboard-only; separately start the Worker with the configured Wrangler command in [Local development](/docs/local-development/) |
| Wrangler/container startup fails | Check the reported Docker/Cloudflare error and local container engine; static build success does not validate container startup |
| Model call fails | Check model ID and account gateway credentials. A 401 means the provider call was not successful; egress routing alone is not inference |
| GitHub access outside approved repo is refused | Egress is scoped to the approved repository; sibling/prefix-lookalike paths are refused |
| Claude Code, Codex, or Devin run fails | These harnesses are present in the image and have unit-tested configuration/egress paths, but the dated verification records no successful live API run for them. OpenCode alone was exercised in the recorded local E2E; its model request returned 401. No cloud E2E is recorded |
| PR publishing fails | `GITHUB_TOKEN` is optional for public diff-only tasks but needed for private GitHub access and PR publishing; see [Configuration](/docs/configuration/) |
| Private repository clone fails | Configure an appropriately scoped `GITHUB_TOKEN`; otherwise use a public test repository |
| A coding run appears stalled | Check run state and logs; configured concurrency is capped at five containers, but actual capacity/quotas depend on Cloudflare account and current service limits |
| Completed badge conflicts with output | Inspect the structured result envelope; failed runs should report error rather than successful completion |
| PR misses deletions or file modes | Publisher behavior is content-based and is not a complete Git patch transport |

`VERIFICATION.md` is dated: its 2026-09-24 summary reports local checks passing and deployment pending, while its 2026-09-19 local OpenCode E2E documents a 401 provider response. Unit tests use fakes; none of these results establishes successful cloud deployment or model inference. Report failures with command, versions, bounded redacted output, expected/actual behavior, and whether the evidence is a unit test, local exercise, or cloud run. Never send secrets or private run transcripts in bug reports.
