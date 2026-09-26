---
title: What a failed run looks like
description: Shiba reports the real exit status, a bounded stderr tail, and a structured error envelope. It never reports a failure as a success.
pubDate: 2026-09-17
category: journal
pattern: protagonist-arc
summary: A build log entry. The recorded local end-to-end run failed with a 401, and the system reported exactly that instead of dressing it up.
---

The most useful thing in this repository is not a passing test. It is a recorded failure.

On 2026-09-19 the team ran a local end-to-end exercise of the full Slack approval chain. The approval worked. The container started. The harness ran. The model call failed. And the system said so.

This post is about that run and the rules that made reporting it honestly the path of least resistance.

<div class="callout">
<span class="callout-label">Prototype status</span>

Shiba is a local prototype. The run described here was a local exercise, not a cloud deployment. The later 2026-09-24 verification summary reports local checks passing with deployment still pending.
</div>

## The run

The exercise ran `wrangler dev` on port 8788 with OrbStack Docker and a `.dev.vars` file carrying test-only Slack values — a signing secret and `SLACK_APPROVERS=U_E2E`.

The chain that got exercised, over real HTTP, was the approval path. A locally HMAC-signed `block_actions` payload was posted to the Slack interact endpoint with a `v0` signature, action `approve`, and a value carrying the thread key and approval id. The endpoint returned a `200` acknowledgment. The approver allowlist admitted `U_E2E`, and the Durable Object resolved the pointer exactly once.

Then the container ran `opencode run --format json --model google/gemini-3.5-flash-lite`.

The provider egress was rewritten to AI Gateway at `…/default/google-ai-studio`. The response was **401, code 2009, Unauthorized**. There was no `AI_GATEWAY_TOKEN` in `.dev.vars` and no bring-your-own key visible.

The run was a failure. Three real bugs surfaced along the way, and one of them was a footgun worth naming: `interact` resolves the orchestrator Durable Object by `threadKey`, and that name has to match the queue target — `default` in this case — not an arbitrary thread key.

## What the system did with the failure

Three things, and all three matter.

**The error propagated as a structured envelope.** It did not get flattened into a log line and lost. The result carried the provider's own status, including the 401 and the code.

**The run was marked `error`.** Not `completed`, not partial, not "finished with warnings." The state is the state.

**The sandbox was destroyed.** A failed run does not leave a container sitting there accruing resources.

The mapping is explicit and simple. An `error` result envelope maps to `error`. A `completed` envelope maps to `completed`. A malformed or absent envelope maps to `error`. There is no path where an unrecognized outcome becomes a success, and that last rule is the one that matters most.

## The rule that shapes everything else

Never silent success.

The failure mode this guards against is specific and tempting: the harness prints something to stdout, the orchestrator sees a non-empty string, and the run gets recorded as completed. The docs call accepting any string output as `completed` explicitly incorrect.

The guard is structural rather than aspirational. The default for an unparseable outcome is failure, not success. A bug in the parser can only make the system look worse, never better. That is the correct direction for a default.

The dashboard reflects the same discipline. The troubleshooting guide lists "Completed badge conflicts with output" as a symptom, and the response is to inspect the structured result envelope: failed runs should report error rather than successful completion. When the badge and the output disagree, the envelope is the source of truth.

## Bounded output, and why bounded

A failing process can produce a lot of text. Shiba captures an 8,000-character stderr tail. That bound is a limit, not a formatting preference.

The other bounds sit alongside it: a 15-minute OpenCode timeout, a 5-minute git command timeout, a 120,000-character collected diff, 20,000 characters of transcript diff display, 50 captured files, 100,000 characters per file, and 500,000 characters of total captured content.

These are application settings defined in `apps/backend/src/runs.ts`, `runtime.ts`, and `transcript.ts`. They are not Cloudflare plan quotas, and they are not guaranteed in-memory read bounds. They are the point at which the system decides it has seen enough, and capture truncation can make publication incomplete — which is a real limitation of a bounded design, not a bug to be papered over.

## What a good failure report contains

The repository's own convention for reporting a failure is written down, and it is stricter than a chat message. A failure report should carry the command, the versions, bounded redacted output, the expected behaviour, the actual behaviour, and — critically — whether the evidence came from a unit test, a local exercise, or a cloud run.

That last item is the one that keeps the record honest. Unit tests use fakes, so a passing unit test is not a deployment. A local exercise is a local exercise. Shiba's own verification file carries this distinction carefully, and the docs repeat it: none of these results establishes successful cloud deployment or model inference.

Two things never go in a report: secrets, and private run transcripts.

## Where the evidence actually stands

Being precise about this is the point of the post, so here it is in one place.

The 2026-09-19 local OpenCode end-to-end run reached the provider and received a 401. The dated verification records no successful cloud run. The later 2026-09-24 summary reports local typecheck, lint, tests, and build passing, with deployment pending.

For the other three harnesses — Claude Code, Codex, and Devin — configuration and egress paths have unit coverage, but the dated verification records no successful live API run. Their event parsers are asserted from their documented stream formats. Unit coverage of a parser is not a live run.

`VERIFICATION.md` is dated, and its two most recent summaries say different things about different things: the 2026-09-19 entry describes a local run that failed at the provider, and the 2026-09-24 entry reports local checks green and deployment pending. Neither one claims a working end-to-end cloud deployment, because neither one has one to claim.

## Why the 401 is the most useful line in the file

A system that has only ever succeeded is a system nobody has learned anything from. The 401 told the team something specific and actionable: egress routing worked, the request reached AI Gateway, and the credential was missing or rejected. That is three facts you cannot get from a green test suite.

It also ruled out a whole class of confusion. Routing alone is not inference. A request can be correctly rewritten, correctly forwarded, and still fail, and the only way to know which stage broke is to report the real status from the real stage.

An agent system that reports its failures precisely is a system you can operate. One that reports a 401 as a completed run is a system you have to manually verify every time, which is worse than having no agent at all.
