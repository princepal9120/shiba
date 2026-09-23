---
title: Troubleshooting
description: Diagnose local builds and known integration limitations honestly.
---

| Symptom | Check or action |
| --- | --- |
| Node/pnpm engine error | Use Node 22.12.0+ and pnpm 10.0.0+; run pnpm install |
| Missing package export after partial install | Reinstall locked dependencies with pnpm install; do not patch node_modules |
| Unknown docs script | Run from the repository root and inspect package.json |
| Docs search absent in dev | Build and run pnpm docs:preview; Pagefind is production-only |
| Docs 404 or stale output | Run the combined pnpm build; Vite alone clears public/docs |
| Vite dashboard cannot connect | Vite has no Worker API/WebSocket proxy; this is UI-only mode |
| Wrangler/container startup fails | Check the actual error and local container engine; static build success is unrelated |
| Model call fails at start | `CODING_MODEL` must be a live id; retired ids throw at fetch. Check wrangler.jsonc and AI Gateway BYOK |
| Out-of-scope GitHub 403 | Egress only authenticates the approved `/owner/repo`; other clones are refused |
| Claude Code / Codex fail at exec | Shipped image installs `opencode-ai` only; other harnesses are unit-tested, not in the image |
| Publish requires GITHUB_TOKEN | Configure the optional secret or leave publishing off |
| Private repository clone fails | Private clone credentials are not wired; use a public test repository |
| Already running 5 coding tasks | Wait or request cancellation; verify actual shutdown |
| Completed badge with error text | Inspect the RESULT_MARKER envelope; failed runs should status error |
| PR missing deletions or file modes | Publisher is content-based, not a complete Git patch transport |

Do not send secrets in bug reports. Include command, dependency versions, bounded redacted error output, expected/actual behavior, and whether the failure is a local build, mocked test, or live integration. Never report a failed dry run as a successful deployment.

See [Readiness](/docs/readiness/) for remaining work and the account-owned acceptance procedure.


