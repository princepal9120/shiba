---
title: Readiness and acceptance checklist
description: Known gaps and evidence required before production use.
---

## Status

**Local prototype — 397/397 tests passing, typecheck and lint clean, build verified.**
The static documentation/dashboard build and mocked tests do not establish that a deployed coding task works end to end. Do not expose it publicly or call it production-ready without completing the live run (T10) and cloud acceptance criteria in PLAN.md §15.

**Shipped in code (unverified live):** dashboard, approval gate, Sandbox egress allowlist, scoped GitHub credential, Cloudflare Access gating, result envelope, progress streaming, Slack mention + slash-command lanes, automations engine (cron/GitHub/webhook/Slack/manual triggers), run_when TypeSafe Noul gate, harness seam (OpenCode/Claude Code/Codex), TypeSafe Choice intent classification wired into Slack dispatch, TypeSafe Score result quality wired into run completion.

## Remaining blockers

- **Live run (T10):** no dated cloud run is recorded. Local tests do not prove deploy, Access, or container billing. See `VERIFICATION.md`.
- **Authorization:** `REQUIRE_ACCESS` only checks the Access email header — not JWT. Cover every hostname with Access; forge-header tests must still fail from outside Access.
- **Harness run proof:** all three CLIs ship in the image (pinned in the `Dockerfile`); OpenCode has been exercised end to end, Claude Code and Codex parsers are unit-tested and unproven against a live CLI until T10.
- **Private cloning:** path-scoped `GITHUB_TOKEN` is for github.com traffic of the approved repo; it is not a clone-time credential store.
- **npm inside the sandbox:** `registry.npmjs.org` is off the egress allowlist on purpose.
- **Lifecycle:** cancellation destroys the sandbox; idle tail is `sleepAfter = 1m`. Registry clear is not complete data erasure.

## Local acceptance

~~~sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm docs:check
pnpm build
pnpm docs:verify
npx wrangler deploy --dry-run --config backend/wrangler.jsonc
~~~

Record actual failures, including missing container runtime/image support. Do not replace a dry run with a real deployment to get a green result. Review package audit findings separately; do not force dependency upgrades without compatibility review.

## Account-owned integration acceptance (not executed by these docs)

After implementing the missing boundaries, use an isolated test installation and a repository you own:

1. Verify unauthorized browser, run API, child-agent, and service requests are denied. Verify authorized browser WebSockets and server-side provider requests work.
2. Submit a harmless README task without publishing; verify no container starts before approval. Reject it and verify no work occurs.
3. Submit again, compare exact proposed input, approve, and observe clone/configure/code/collect phases.
4. Compare actual changes to the transcript, including new files, diff, exit status, truncation, and redaction.
5. Verify no-change and controlled failure tasks are reported honestly.
6. Cancel during execution, verify the process stops, and confirm late output cannot revive a cancelled record.
7. Exercise the three-run limit, reconnect, retained history, and clear-history partial failures.
8. On a dedicated test repository, explicitly approve publishing and verify the intended branch and PR; do not use production repositories for this test.
9. Check keyboard operation, narrow/desktop layouts, docs navigation/search, and missing-path 404 behavior.

Record date, revisions, versions, environment, results, and unresolved failures. Mocked tests alone are insufficient to mark the product complete.

