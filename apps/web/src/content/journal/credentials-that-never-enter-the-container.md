---
title: Credentials that never enter the container
description: A walk through the egress boundary, timed and actor by actor, showing where every secret is actually substituted.
pubDate: 2026-09-15
category: guide
pattern: choreography
summary: The container holds a dummy key. Everything real is swapped in outside it, one hop from the network call.
---

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Shiba is a local prototype. No live end-to-end cloud run is claimed here, and no penetration test, user count, or benchmark is claimed. The boundary described here is enforced in code and covered by unit tests; that is an implementation claim, not proof of a live deployment.</p>
</div>

The most dangerous moment in an agent system is not the model call. It is the moment a real credential becomes reachable by a process that reads untrusted text.

Shiba's answer is a single invariant, stated the same way in the specification, the README, and the security documentation: the container never holds a real provider key. Everything else in this post is that one sentence, timed.

## The actors

There are only three, and keeping them distinct is the whole design.

**The container.** A real Docker process, running a real coding CLI, reading files from a cloned repository that a model was told to modify. It is the least trusted party in the system, and it is designed that way — it processes adversarial input by definition, because the input is a task description and the repository content.

**The Sandbox Durable Object.** This sits outside the container, at the network boundary. It holds the allowlist, the handlers, and the real credentials. It is the only party that talks to both the inside and the outside.

**The account owner.** The person who deployed this. Their provider key lives in their AI Gateway; their GitHub token lives as a Worker secret. Neither is visible to anything running in a container, because neither is ever sent to one.

## Time one: the container is configured

The container process is handed a dummy key — the environment variable literally named `DUMMY_PROVIDER_KEY`. It is a placeholder with the shape of a credential and none of the value. The CLI inside the container cannot tell the difference, and does not need to: it will attach the placeholder to its provider request exactly as it would attach a real one.

The configuration handed to the container is deliberately minimal. For the Devin harness, the container's own credentials file carries a dummy too, and a Worker-side forwarder swaps in the real service key on the way out.

This is the moment the invariant holds, and it holds trivially: the real secret was never in scope to be leaked.

## Time two: the container dials out

The CLI inside the container issues an HTTPS request to its provider host. It believes this is a normal network call. It is not — outbound traffic is intercepted at the Sandbox egress boundary before it leaves.

The allowlist is evaluated first, and it is deny-by-default. `allowedHosts` admits only the hosts the current run is entitled to reach. In the shipped configuration that is the selected harness's provider host plus git; `registry.npmjs.org` is deliberately excluded, because allowing package installs inside a run is simultaneously a convenience feature and the widest exfiltration channel available.

Because the list is evaluated before any handler runs, a request to an unlisted host is refused at the allowlist, not politely handled downstream.

## Time three: the boundary substitutes the real credential

Now the Durable Object forwards the provider-native request through the account owner's AI Gateway binding, and the real provider credential — which has been sitting in AI Gateway the entire time — authorizes it. The real key is used in the forward. It is never written into the container, the container's environment, its config, a clone URL, a log line, or a UI response.

There is no callback route. The old provider-callback path was deleted; the forwarder and its route no longer exist. All provider traffic is this one direction: container makes a request, boundary rewrites and forwards it, response comes back. There is no inbound endpoint for a provider to call, and therefore no inbound endpoint to secure.

The handoff is complete in a single hop. The container does not need to know, and never learns, that the credential it is holding is a placeholder.

## The git credential, scoped to one repository

The GitHub token is the second credential and it is handled differently, because it is a different kind of power.

`GITHUB_TOKEN` is attached by the Worker at the egress boundary — never inside the container — and it is scoped to the run's own repository. `github.com` egress *defaults to refusal*. Before the clone, the run calls `approveRepoScope("/owner/repo")`, which installs a forwarder for that one path. Any request for a different repository is refused, with no `Authorization` header attached at all. A sibling repository that shares a prefix — `/owner/repo-evil` — is refused too, because a prefix match is not a scope match.

The clone is refused until the scope is installed, and the tests assert the scope is proven *before* the clone, not after. A run that never scoped itself gets no credential at all. And even with the token attached, only read-style git traffic plus `git-upload-pack` passes: container pushes are refused, so the container cannot push even holding a token that could otherwise push.

Pull request publishing happens the other way around, from Worker code against the GitHub API, using captured file contents — never from inside the container.

## One image, four harnesses, one boundary

The image ships four coding CLIs: OpenCode, Claude Code, Codex, and Devin. The credential invariant has to hold for all of them, and it does — every harness passes the container a dummy and nothing matching a real credential shape.

The allowlist is narrowed per run to the *selected* harness's provider host plus git, never the union across harnesses. Choosing Claude Code does not leave OpenAI's host reachable. This is the difference between a policy that says "we support four providers" and one that says "for this run, this provider, this host, and git — nothing else."

Subscription credentials are a separate boundary and deliberately unsupported. Claude Code and Codex are API-key harnesses only; Anthropic's terms forbid third parties routing requests through Free, Pro, or Max plan credentials on behalf of users, so the system does not proxy them.

## The honest limit

The security documentation is careful about what this evidence means, and the care is worth preserving.

These boundaries have unit coverage. The allowlist policy and the handlers are exercised by tests. That is an implementation and test claim — it is not a cloud penetration-test result, and it does not establish that a deployed hostname is covered by the intended Access application. `VERIFICATION.md` records a forged-header 401 check against a deployed Worker; it does not record a cloud end-to-end coding run.

The retention caveat is stated just as plainly: clearing history or the run registry does not erase all child Durable Object data or stop already-running containers, and cancellation is best-effort. Review retention requirements before pointing this at confidential repositories, and use least-privilege credentials scoped to test repositories.

The invariant is simple enough to hold in your head — the container holds a placeholder, the boundary holds the real thing, and the two never meet — and the reason it is worth this much attention is that the entire safety story of an agent system rests on that one sentence remaining true under every code path.
