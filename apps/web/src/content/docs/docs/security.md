---
title: Security
description: Authentication, credential boundaries, and known limitations.
---

## Installation boundary

Each installation is account-owned; the application does not provide cross-customer multi-tenant isolation. Put Cloudflare Access in front of the Worker route before exposing it: an obscure URL is not protection. Deployment configuration and Access policies are account-owned and must be verified for every hostname.

When `REQUIRE_ACCESS` or `ACCESS_AUD` is enabled, the Worker requires an authenticated identity for ordinary routes. With `ACCESS_AUD`, `apps/backend/src/access-jwt.ts` verifies the RS256 Access JWT (issuer/JWKS and audience) and rebuilds the email identity from that token; a client-supplied email header is not trusted. Signature-authenticated Slack/GitHub routes, automation webhooks, and bearer-token MCP routes use their own authentication and are exempt from Access identity checks. Configure matching Access policies/bypasses for those integrations. This code-level behavior is tested; it does not prove that a deployed hostname is covered by the intended Access application. `VERIFICATION.md` records a deployed-Worker forged-header 401 check, but no cloud end-to-end coding run.

## The credential boundary

Provider credentials are not supplied to provider-backed harnesses in the container: they receive a dummy key and provider requests are forwarded at Sandbox egress (`apps/backend/src/egress.ts`). The Devin service harness is an exception: it uses a dummy in-container key and a Worker-side forwarder replaces authorization with `DEVIN_API_KEY`. These boundaries have unit coverage; do not treat that as proof of a cloud deployment:

- **Model traffic.** The container is given a dummy key and calls its selected provider host. The Worker forwards supported provider requests through the configured AI Gateway binding; successful inference still depends on account configuration and credentials. There is no provider callback route.
- **Repository traffic.** `GITHUB_TOKEN` is attached in the Worker, never in the container.

### Deny-by-default egress

`Sandbox.allowedHosts` is an allowlist evaluated *before* any outbound handler. The Sandbox allowlist restricts outbound hosts; tests exercise the configured policy and handlers. This is an implementation/test claim, not a cloud penetration-test result. `registry.npmjs.org` is deliberately **not** on the list in v0.1: it would enable `npm install` inside runs and is simultaneously the widest exfiltration channel available.

### The GitHub credential is scoped per run

`github.com` defaults to **refusal**. Before the clone, the run calls `approveRepoScope("/owner/repo")`, which installs a scoped forwarder for that one path. Requests to any other repository get 403 with no `Authorization` header attached: repository code cannot reach every repo the token can. Sibling repositories that share a prefix (`/owner/repo-evil`) are refused too.

A run that never scoped itself gets no credential at all.

## Automation safety

An automation is an approval gate with nobody standing at it, so three controls apply together (`authorizeAutomationRun`):

1. **Approval is required by default.** An automation schedules work; it does not authorize it.
2. **Unattended mode is opt-in and narrow.** It is granted only when opening a pull request is the run's only mutation *and* the repo is on that automation's explicit allowlist. A PR is reviewable and revertible; nothing else is.
3. **A daily run budget per automation.** A cron misconfiguration or a webhook loop otherwise burns tokens until somebody notices, and both provider inference and platform resource usage may incur account charges.

The optional `run_when` gate asks the cheap Workers AI orchestrator model whether a plain-language condition holds before a run starts. It **fails closed**: a model error, an empty answer, or anything not clearly affirmative means no run, and the reason is recorded rather than dropped.

Kill switches: `enabled` per automation, and the `AUTOMATIONS_ENABLED` var globally.

## Other implemented safeguards

- Repository URL validation requires HTTPS GitHub and rejects embedded credentials.
- Dynamic shell arguments use tested POSIX quoting helpers.
- The parent delegation tool requires human approval of the exact structured input that will execute, never a summary of it.
- Slack requests are verified with a v0 HMAC and a 5-minute replay bound; Block Kit approvals additionally require the clicker to be on `SLACK_APPROVERS`, because a signature authenticates Slack, not the human. An unset allowlist means nobody can approve from Slack.
- Run results are parsed from a structured envelope, so a failed run cannot display as a successful one.
- Output paths apply bounds and known-pattern redaction. This is not a guarantee against arbitrary secrets or binary data. Never put secrets in tasks or repositories.
- Cancellation keeps its terminal registry state against late completion; container destruction is best-effort.

## Retention and review

Clearing history or the run registry does not erase all child Durable Object data or stop running containers. Review retention and deletion requirements before using confidential repositories.

Treat generated code as untrusted. Review changes and run tests. Use least-privilege credentials restricted to test repositories. Publishing opens a PR and never merges it, and publication is not a lossless Git patch transport.

Sources: [Access](https://developers.cloudflare.com/cloudflare-one/access-controls/), [service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/), [Sandbox outbound traffic](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/).

Local implementation: `apps/backend/src/index.ts`, `apps/backend/src/egress.ts`, `apps/backend/src/sandbox.ts`, `apps/backend/src/security.ts`, `apps/backend/src/automations.ts`, and `apps/backend/src/agents/orchestrator.ts`. See [Readiness](/docs/readiness/).
