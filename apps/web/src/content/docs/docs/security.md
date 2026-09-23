---
title: Security
description: Authentication, credential boundaries, and known limitations.
---

## Installation boundary

Each installation is single-tenant and account-owned. There is no multi-tenant isolation. Put Cloudflare Access in front of the Worker route before exposing it: an obscure URL is not protection.

Live Alchemy deploys set `REQUIRE_ACCESS` so the Worker fails closed, and with `ACCESS_AUD` the identity comes only from a verified `Cf-Access-Jwt-Assertion` JWT: `/api/runs`, the agent WebSocket, and static assets all require a `cf-access-authenticated-user-email` identity. Paths the Worker authenticates itself (`/api/slack/events`, `/api/slack/command`, `/api/slack/interact`, `/api/github/webhook`, `/mcp`, `/api/automations/*/trigger`) are exempt by construction, because Slack, GitHub, and MCP clients cannot complete an Access login: those routes need a matching **bypass policy** on the Access application too.

**Stated limit:** the Worker checks for the Access header, which is not JWT verification. Anyone who can reach the Worker origin directly can forge it. The route must not be exposed outside Access. JWT verification is filed for v0.2.

## The credential boundary

No real credential ever enters a container. Egress is intercepted in the Worker (`apps/backend/src/egress.ts`), where the real key is swapped in:

- **Model traffic.** The container is given a dummy key and calls `generativelanguage.googleapis.com` directly. The Worker forwards it through the account owner's AI Gateway binding, which injects the stored BYOK credential. There is no provider callback route.
- **Repository traffic.** `GITHUB_TOKEN` is attached in the Worker, never in the container.

### Deny-by-default egress

`Sandbox.allowedHosts` is an allowlist evaluated *before* any outbound handler. Anything unlisted cannot leave the container, including code the agent runs from the repository. `registry.npmjs.org` is deliberately **not** on the list in v0.1: it would enable `npm install` inside runs and is simultaneously the widest exfiltration channel available.

### The GitHub credential is scoped per run

`github.com` defaults to **refusal**. Before the clone, the run calls `approveRepoScope("/owner/repo")`, which installs a scoped forwarder for that one path. Requests to any other repository get 403 with no `Authorization` header attached: repository code cannot reach every repo the token can. Sibling repositories that share a prefix (`/owner/repo-evil`) are refused too.

A run that never scoped itself gets no credential at all.

## Automation safety

An automation is an approval gate with nobody standing at it, so three controls apply together (`authorizeAutomationRun`):

1. **Approval is required by default.** An automation schedules work; it does not authorize it.
2. **Unattended mode is opt-in and narrow.** It is granted only when opening a pull request is the run's only mutation *and* the repo is on that automation's explicit allowlist. A PR is reviewable and revertible; nothing else is.
3. **A daily run budget per automation.** A cron misconfiguration or a webhook loop otherwise burns tokens until somebody notices, and tokens, not compute, are the bill.

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
