---
title: What a failed run looks like
description: Exit codes, bounded stderr, and the rule that a failed run may never render as a successful one.
pubDate: 2026-09-17
category: journal
pattern: protagonist-arc
summary: The most important property of a coding agent is not that it succeeds. It is that its failures are legible.
---

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Shiba is a local prototype. The failure shapes described here are enforced in code and recorded in the repository's dated verification file. No live end-to-end cloud run is claimed.</p>
</div>

An agent that fails obviously is a tool. An agent that fails quietly is a liability.

This is the least glamorous thing in the repository and the thing I would defend hardest in review, because the pressure to make failure look like success is constant and it is almost always locally rational. A run that reports an error is an unpleasant screen. A run that reports success is a relieved user. Everything that makes the second option tempting is a short-term improvement and a long-term betrayal.

## The requirement, written down before anything existed

The specification's list of what the sandbox must do includes one item that is not a feature: *report failures honestly, including process exit code and a bounded stderr tail.*

The same document's closing rules are blunter still — no fake successful output, no generated placeholder implementation. Those are constraints on the build, not features, and they were written before the run pipeline existed. That ordering matters. When the failure path is specified in the same breath as the happy path, the happy path cannot quietly absorb it.

## The envelope, and why the transport is not enough

The implementation answer is a structured result envelope. When a run finishes, the parent receives a marker-wrapped structure carrying a status, and that structure — not the transport, not the exit of some intermediate process, not the presence of a completion badge — is the source of truth for whether the run worked.

The design note is worth quoting because it is the kind of line that only gets written after it has been learned the hard way: trust the parsed envelope, not the transport type. A stream can end cleanly while the work failed. A tool can report progress while the process is dying. Only a parsed, structured, terminal status answers the question.

The invariant is testable and tested: an error envelope never reads as completed. If the status is an error, the UI shows an error, no matter what else happened along the way.

## What a failure actually carries

The parts of a failure report that matter are the ones that let you act without re-running the job:

- **The real exit code.** Not a generic 1. If the harness exited non-zero, that number is what you get.
- **A bounded stderr tail.** Enough of the actual error text to diagnose, and explicitly bounded so a runaway process cannot fill a Durable Object with megabytes of log. The current bound is 8,000 characters.
- **The phase.** Whether the run died cloning, launching the harness, or collecting the diff changes what you investigate first.
- **Redaction.** Known credential patterns are stripped from output paths before anything is stored or displayed.

Redaction is described in the documentation as a bound and a known-pattern filter, explicitly *not* a guarantee against arbitrary secrets or binary data. The instruction that follows is the operative one: never put secrets in tasks or repositories. A redaction filter is a safety net, not a licence to be careless.

## A real failure, from the dated record

The 2026-09-19 local end-to-end exercise is the most useful failure in the repository, precisely because it did not succeed.

The chain worked: a task was queued, a locally signed Slack approval was accepted, the Durable Object dispatched, a real container came up, GitHub egress was scoped to the requested repository, the clone succeeded, and the harness launched with the expected arguments. Then the provider call was rewritten to the AI Gateway and returned 401. No gateway credential was configured in the local environment.

And that 401 was reported as a 401. The run was marked as an error, the structured envelope carried it, and the container was destroyed. The verification file does not describe this run as a success with a caveat. It describes the model call as not verified, names the missing account configuration, and separately notes that a 401 means the provider call was not successful — egress routing is not inference.

That is the behaviour this whole post is about. The most flattering possible summary of that run would have been "end-to-end pipeline verified." It would even have been mostly true. It is also exactly the kind of sentence that makes a system untrustworthy six months later.

## Failure modes that are refused by design

Some failures are prevented rather than reported, and those are the interesting ones:

**A retired or unsupported model id** is refused at startup rather than failing on the first provider call. A model that no longer exists should not cost you a container to discover.

**A mismatched harness and model pairing** is refused while the approval is prepared, so a plan you are looking at is always a plan that can run.

**A pull request requested with no token configured** fails before any coding starts, with a configuration error, rather than doing the work and then failing to publish it.

**An oversized file tree** fails the run instead of publishing a partial pull request. A truncated result presented as a complete one is a correctness bug, not a degraded mode.

**An automation whose `run_when` gate errors** fails closed — no run — and records why. Here the failure is *not running*, which is the safe direction.

## The limits of honest failure

Honest failure reporting does not make a system reliable. It makes it legible, and legibility is what lets you decide whether to trust it.

The repository is careful about the difference. Publication of results is content-based and is not a lossless Git patch transport, so a published pull request can miss deletions or file modes. Capture truncation can make publication incomplete. Cancellation is best-effort — it is not process cancellation and not complete Durable Object erasure. A run appearing to stall may be a concurrency or capacity condition, not a bug.

None of those are hidden, and none of them are dressed up as features.

## What still has to be proven

The completion plan's central acceptance bar includes a failing task reporting its real exit code and a pull request showing a deleted file as deleted. That bar has not been met against a live cloud run, and the verification file says so. The local unit coverage and the local end-to-end exercise are real evidence of what has been tested; they are not evidence of a deployed system behaving the same way.

The gap is stated rather than papered over, which is the same discipline this post is about. A prototype that tells you exactly which of its failure paths are proven, and which are still assertions, is usable. One that claims all of them are proven is not — and you cannot tell the difference until the day it matters.

## The rule I would keep

If you take one thing from this, make it the ordering. Build the failure path first, or at least specify it first. Make the success path unable to swallow it. Then, when something breaks at two in the morning, the system will hand you an exit code and a stderr tail instead of a reassuring green badge — and you will know exactly how much of the rest to believe.
