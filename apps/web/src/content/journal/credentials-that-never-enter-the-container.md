---
title: Credentials that never enter the container
description: A walk through what Shiba hands to the sandbox, what it holds back, and where each key is actually attached.
pubDate: 2026-09-15
category: guide
pattern: choreography
summary: Actors, keys, and handoffs traced from your machine to the sandbox and back out to the provider.
---

This post is a choreography. It follows four actors across time and shows where
each secret lives at every step. The cast is the sandbox container, the Sandbox
Durable Object, the Worker, and Cloudflare AI Gateway.

Every detail here comes from `README.md` and
`apps/web/src/content/docs/docs/security.md`. Shiba is a local prototype with
unit coverage on these paths. That is not proof of a cloud deployment, and this
post makes no claim about a live end-to-end run.

## The one-sentence rule

`README.md` says it directly: do not add provider credentials to the container.

The container receives `DUMMY_PROVIDER_KEY`. The Sandbox Durable Object swaps in
the real AI Gateway credential outside the container, at egress. The credential
invariant holds for every harness.

That is the whole design in one sentence. The rest of this post is the
consequences.

## Actor one: the container

The container is the least privileged actor and the most noisy one. It clones a
repository, runs a coding harness, writes files, and streams output back to the
parent UI. It has a working key-shaped value and nothing behind it.

`security.md` states that provider credentials are not supplied to
provider-backed harnesses in the container. They receive a dummy key, and
provider requests are forwarded at Sandbox egress, in
`apps/backend/src/egress.ts`.

`spec/GOAL.md` puts the same rule in the sandbox's own requirement list as item
seven: never pass real model-provider credentials into the container process.
It also says the real provider key or Unified Billing credential must stay in AI
Gateway, outside the container.

## Actor two: egress

The dummy key has to work well enough that a harness does not notice the swap.
The container calls its selected provider host, and the request is intercepted
and forwarded through the configured AI Gateway binding.

`spec/GOAL.md` describes the mechanism for the default path: intercept the
container's HTTPS egress in the Sandbox Durable Object and forward the
provider-native request through the account owner's AI Gateway binding.

`security.md` adds two constraints worth naming. Egress is narrowed to the
selected harness's provider host plus git, never the union across harnesses.
There is no provider callback route. Inference is outbound only.

## Actor three: AI Gateway

Gateway is where the real credential lives. `README.md` notes that adding a
provider key (BYOK) to the `default` AI Gateway is still a manual step.

`security.md` is careful about what forwarding proves: successful inference
still depends on account configuration and credentials. A `401` from a provider
is a real failure, and `troubleshooting.md` is direct about it. A 401 means the
provider call was not successful, and egress routing alone is not inference.

## Actor four: the Worker and GITHUB_TOKEN

Git is a separate credential with a separate handoff. `spec/GOAL.md` allows
`GITHUB_TOKEN` only as a Wrangler secret, and only for optional GitHub access.
Public repositories and diff-only tasks must work without it.

If `publishPullRequest` is true and no token exists, the system must fail before
coding with a clear configuration error. If it is configured, the token stays
out of the container. Git transport authorization is injected through Sandbox
HTTPS interception, and the pull request API is called from Worker code.

The same line lists where the token must never appear: a clone URL, a command,
the process environment, a log, or a UI response. `security.md` compresses it:
`GITHUB_TOKEN` is attached in the Worker, never in the container. `README.md`
adds that it is scoped to the approved repo for git traffic, is also used for
Worker-side PR publishing, and should be a fine-grained token scoped to that
repo.

## Time, as a sequence

Fold the actors into order and the run reads like this.

1. A human approves a plan. No container exists yet.
2. The sandbox validates an HTTPS GitHub URL, clones the requested branch, and
   starts a harness.
3. The harness is handed a dummy key, and the process environment contains no
   real credential.
4. The harness makes a provider request to its allowed host. Egress intercepts
   it and forwards it through AI Gateway, which holds the real key.
5. Git traffic is authorized in the Worker, not the container.
6. On completion, cancel, or reclaim, the sandbox is destroyed.

Each step hands the work forward without handing over the secret.

## The Devin exception

One harness does not fit the AI Gateway shape. The `devin` harness is not an AI
Gateway provider. Its CLI authenticates to Cognition's own backends with an
account API key set as a Worker secret, `DEVIN_API_KEY`. The container's
`credentials.toml` carries a dummy, and the egress forwarders replace the
authorization header with the real Bearer.

The invariant survives the exception, but only because the swap happens in a
different place.

## What is not claimed

`security.md` is explicit that these boundaries have unit coverage and that you
should not treat that as proof of a cloud deployment. The unit tests use fakes.
`VERIFICATION.md` lists the live cloud run as not attempted.

Two things are deliberately absent from this post. There is no measured price or
end-to-end cloud usage to report, and there is no latency comparison between
configurations. The costs document omits earlier cost-ratio language on purpose,
because it is not evidenced.

Read next: [harness and model choices](/blog/harness-and-model-choices/).
