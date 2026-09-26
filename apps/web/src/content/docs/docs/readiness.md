---
title: Readiness and acceptance checklist
description: Known gaps and evidence required before production use.
---

## Evidence status (2026-09-24)

**Implemented** describes code present; **unit-tested** describes mocked/component tests; **locally exercised** describes the dated `wrangler dev` run below. None of these means cloud-live. The latest recorded checks in [`VERIFICATION.md`](/docs/readiness/#evidence-status-2026-09-24) report typecheck, lint, 995 tests, build, and frontend smoke passing. The Worker/container dry run was blocked because Docker was unavailable; the Worker/assets-only dry run passed with container rollout disabled. Alchemy planning reached the expected missing-Cloudflare-OAuth error. No cloud deployment or cloud end-to-end run is recorded.

### Implemented and unit-tested

The repository contains the approval/run flow, dashboard, harness adapters, provider/GitHub egress handlers, Access JWT verification, Slack lanes, automation triggers and safety gates, and MCP run tools. Their behavior has targeted tests; the full suite result is the dated result above, not proof of a deployed integration. Claude Code and Codex harness configuration/parsers are tested, but neither CLI has completed a real provider-backed run.

### Locally exercised

The 2026-09-19 `wrangler dev` run exercised queue → signed Slack approval → Durable Object dispatch → Docker container → scoped GitHub clone → OpenCode launch → provider-forwarding failure (401, because no gateway/BYOK credential was configured) → structured error and cleanup. The 2026-09-24 verification also reports a deployed-Worker check that forged Access identity headers are rejected. These are distinct from a cloud end-to-end coding run; model inference was not established by the local run.

### Cloud-live

**No cloud end-to-end run is recorded.** Do not describe the product as production-ready or claim cloud-live container execution, model inference, PR publication, or billing behavior. Deployment remains blocked pending Docker-capable validation and Cloudflare OAuth/profile setup. `VERIFICATION.md` is the dated source of truth for later status.

## Remaining gaps

- **Deployment/e2e:** complete a dated cloud run against the acceptance bar in PLAN.md §15; record deploy revision, environment, outcome, and failures.
- **Provider-backed execution:** local OpenCode reached the provider boundary but received 401; configure and verify a valid Gateway/BYOK credential before claiming inference works.
- **Other harnesses:** Claude Code and Codex have not run against live APIs.
- **Resource measurements:** peak memory, cold start, and WebSocket Hibernation behavior are unmeasured; do not infer cost/performance from local tests.
- **Retention/lifecycle:** cancellation requests best-effort sandbox destruction; clearing history is not complete data erasure.

## Local acceptance

~~~sh
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
npx wrangler deploy --dry-run --config apps/backend/wrangler.jsonc
~~~

Record actual failures and date. A dry run is not a live deployment. Review package audit findings separately; do not force dependency upgrades without compatibility review.

## Account-owned integration acceptance (not executed by these docs)

For account-owned integration acceptance, use an isolated test installation and a repository you own:

1. Verify unauthorized browser, run API, child-agent, and service requests are denied. Verify authorized browser WebSockets and server-side provider requests work.
2. Submit a harmless README task without publishing; verify no container starts before approval. Reject it and verify no work occurs.
3. Submit again, compare exact proposed input, approve, and observe clone/configure/code/collect phases.
4. Compare actual changes to the transcript, including new files, diff, exit status, truncation, and redaction.
5. Verify no-change and controlled failure tasks are reported honestly.
6. Cancel during execution, verify the process stops, and confirm late output cannot revive a cancelled record.
7. Exercise the five-run application concurrency limit (`MAX_CONCURRENT_RUNS = 5`), reconnect, retained history, and clear-history partial failures.
8. On a dedicated test repository, explicitly approve publishing and verify the intended branch and PR; do not use production repositories for this test.
9. Check keyboard operation, narrow/desktop layouts, docs navigation/search, and missing-path 404 behavior.

Record date, revisions, versions, environment, results, and unresolved failures. Mocked tests alone are insufficient to mark the product complete.

