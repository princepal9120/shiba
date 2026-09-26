---
title: The credentials that never enter the container
description: How Shiba runs a real coding agent with a dummy key in the process and a real one at the egress boundary.
pubDate: 2026-09-15
category: guide
pattern: choreography
summary: The container runs a coding harness against a fake API key. The real credentials are attached outside it, per request, only after a human approves the run.
---

There is a moment in every Shiba run where a coding agent needs to call a model provider. The agent runs inside a container. The provider key is a real secret. The obvious design puts the key in an environment variable and moves on.

Shiba does the opposite. The container gets `DUMMY_PROVIDER_KEY`. The real AI Gateway credential is substituted outside the container, at the egress boundary, by the Sandbox Durable Object. This post is about how that substitution works and why the surrounding choreography matters more than the trick itself.

<div class="callout">
<span class="callout-label">Prototype status</span>

Shiba is a local prototype. The egress and credential paths are implemented and unit-tested. No live end-to-end cloud run is recorded, and no penetration test against a deployed instance is claimed.
</div>

## The actors

Four parties are involved, and keeping them distinct is the whole design.

**The orchestrator** is Worker code. It plans the task, presents it for approval, and owns the secrets. It never runs inside the container.

**The container** is an isolated Cloudflare Sandbox instance holding a checkout of one branch. It runs a pinned harness CLI — `opencode`, `claude-code`, `codex`, or `devin` — and it has no real credentials for anything.

**The Sandbox Durable Object** sits between the container and the internet. It intercepts HTTPS egress, decides which hosts are reachable, and attaches the real credentials to the requests it forwards.

**The providers and GitHub** sit on the other side. They see requests from the Durable Object. They never see the container directly.

If the container is compromised — by a malicious dependency, a bad shell command, an over-broad agent — the attacker holds a dummy key and an allowlist. The real secrets are not in the blast radius.

## Deny by default

Egress is not open with a few rules bolted on. `interceptHttps` is enabled and the default is refusal. A run gets an explicit host allowlist, and the notable entries are `generativelanguage.googleapis.com`, `github.com`, and `codeload.github.com`.

`registry.npmjs.org` is deliberately absent. That means `npm install` inside a run is refused, which the docs call out as a known consequence rather than a bug. A harness that wants a dependency it does not have will fail, and failing is the correct outcome for a system whose job is to not silently expand its own permissions.

The allowlist is also narrowed per run to the selected harness's provider host plus git — never the union across harnesses. A run on the Devin harness does not inherit Google's egress just because both are in the image.

## Model calls: dummy in, real out

When the container's harness calls the provider, it does so with a fake key. The Sandbox Durable Object intercepts the HTTPS request and forwards it through the account owner's Cloudflare AI Gateway binding, swapping in the real credential on the way out.

The consequence is a clean split. Inside the process there is nothing worth stealing. Outside the process there is a key that never entered it. The provider key, or the Unified Billing credential, lives in AI Gateway and stays there.

The same invariant holds for every harness. Claude Code and Codex are API-key harnesses only; subscription credentials are deliberately not proxied, because Anthropic's terms forbid routing requests through Free, Pro, or Max plan credentials on behalf of users. The Devin CLI authenticates to Cognition's own backends with a Worker secret `DEVIN_API_KEY`, and its `credentials.toml` in the container carries a dummy that the egress forwarders replace with a real Bearer.

## The GitHub token

GitHub is the more interesting case, because git traffic is not a single request.

`GITHUB_TOKEN` is a Wrangler secret on the Worker. It is attached by the Worker at the egress boundary for git traffic to the approved repository only, and it is also used for Worker-side pull-request publishing. It is never placed in the container, and never appears in the clone URL, the command, the process environment, the logs, or UI responses.

Access is scoped rather than global. GitHub access defaults to refusal. `approveRepoScope("/owner/repo")` installs a scoped forwarder for one repository; a run without an approved scope receives no credential at all. Requests for any other repository are refused with a 403 and no `Authorization` header. Sibling and prefix-lookalike paths are refused too.

Even for the approved repo, the container is not trusted to push. Only `GET`/`HEAD` and `POST git-upload-pack` pass. Git authorization is injected by the same interception layer, so the container never holds a token that could write.

`GITHUB_TOKEN` is optional for public repositories and diff-only tasks. If `publishPullRequest` is set to true without a token, the run fails early with a clear configuration error instead of failing later inside a git command.

## Webhooks, and the difference between acknowledging and acting

`GITHUB_WEBHOOK_SECRET` verifies incoming webhook requests. Those requests are acknowledgment-only: the system validates the signature and confirms receipt. It does not let a webhook drive a mutation on its own. Any work that follows still passes through the approval gate.

This is the same discipline applied to Slack. A valid Slack signature authenticates that the request came from Slack, not which human clicked the button. So `SLACK_APPROVERS` is deny-by-default: unset means nobody can approve from Slack.

## Why the choreography is the security property

Any one of these controls is a line of code. Together they are a sequence, and the sequence is what holds.

The orchestrator holds secrets and does not run agent code. The container runs agent code and holds no secrets. The Durable Object is the only component that sees both, and it exists to translate between them under an explicit allowlist. The approval gate ensures none of it starts until a human has said which repository and which commands are acceptable.

If you removed any single piece, the others would not compensate. Remove the gate and a compromised container can act on an approved scope without a human in the loop. Remove the allowlist and the dummy key becomes irrelevant. Remove the dummy key and the container becomes the thing holding the secret.

The dummy key is the memorable part. The property it creates — real authority lives outside the thing you do not trust — is the actual design.
