---
title: What a failed run looks like
description: Shiba reports failures with a real exit code, a bounded stderr tail, and an error envelope, and never dresses a failure up as a success.
pubDate: 2026-09-17
category: journal
pattern: protagonist-arc
summary: A run is stopped mid-flight, and the record it leaves behind is an error with evidence rather than a success badge.
---

![Glass console beneath a fractured holographic error panel](/blog/what-a-failed-run-looks-like.png)

This is a build log entry, told as a story. A coding run is queued, it starts,
and it does not finish. What matters is what the record looks like afterwards.

Sources: `spec/GOAL.md`, `PLAN.md`, `VERIFICATION.md`, and
`apps/web/src/content/docs/docs/troubleshooting.md`. Shiba is a local
prototype, and this post describes required and unit-tested behaviour rather
than a verified live cloud run.

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>The rules below are code requirements with unit coverage. A live cloud run
  is recorded as not attempted, and the verification record is dated, so treat
  it as an honest account rather than a live demonstration.</p>
</div>

## The requirement

`spec/GOAL.md` gives the sandbox a numbered list, and item six is the one this
post is about: report failures honestly, including process exit code and a
bounded stderr tail.

Item five, capturing changed files and a unified diff including new files, sits
directly above it. A run that produced a diff and then failed still has a diff,
and the report has to say so without dressing the partial work up as a finished
task.

`spec/GOAL.md` closes the same section with a rule about the assistant's own
output: no generated placeholder implementation, no fake successful output, no
external deployment, no push. If a dry run cannot complete because no compatible
local container engine is running, the exact limitation gets recorded, while
the TypeScript build and unit tests still have to pass.

## The envelope

`PLAN.md` describes the structured result a run returns. Error envelopes must
report `error`. A malformed result, or an absent one, is `error` too. The plan's
word for the failure mode is never silent success.

`troubleshooting.md` turns that into a symptom you can actually see. If a
completed badge conflicts with the output, inspect the structured result
envelope, because failed runs should report error rather than successful
completion.

That conflict is the bug this rule exists to prevent. A UI that shows a green
completion for a run whose envelope says `error` is lying about the run, and the
envelope is the source of truth.

## What the failure message carries

`PLAN.md` requires failure messages to include the real error and the real exit
code, passed through `safeText` and `redactSecrets` before they leave the
runtime. Redaction is not optional formatting; it is what allows a real error to
be reported at all.

The tail is bounded. `costs.md` lists the stderr tail at 8,000 characters, with
the collected diff at 120,000, the transcript diff display at 20,000, captured
files at 50, per-file captured contents at 100,000 characters, and total captured
contents at 500,000. These are application settings, not guaranteed in-memory
read bounds, and capture truncation can make a publication incomplete.

So a failure report is deliberately partial. It is partial by design, and the
limit is documented rather than discovered.

## The record-keeping rule

`PLAN.md` also sets the standard for the build log itself. Record the date, the
versions, and every failure. A failing task reports its real exit code.

`VERIFICATION.md` is written to that standard, which is why it contains awkward
lines. A live cloud run is listed as not attempted. The one local end-to-end
exercise with OpenCode on 2026-09-19 returned a 401, so model inference was not
verified. Claude Code and Codex have not run live. `troubleshooting.md` adds
that the verification file is dated, that unit tests use fakes, and that none of
it establishes successful cloud deployment or model inference.

An unflattering 401 in the record is the system working. A green run nobody can
reproduce is the failure mode.

## How to report one yourself

`troubleshooting.md` gives the format for a bug report: the command, the
versions, bounded redacted output, the expected and actual behavior, and whether
the evidence is a unit test, a local exercise, or a cloud run. Never send secrets
or private run transcripts.

Label the evidence type and the claim follows it. A 401 means the provider call
was not successful, and egress routing alone is not inference. If the container
engine is missing, say the container engine is missing, because static build
success does not validate container startup.

## Why the honesty costs something

Bounded tails mean you cannot always see why a run failed. Redaction means the
exact secret-adjacent line is gone. Truncation means a publication can be
incomplete. A refused config check means a run you wanted did not start.

Each of those is a worse experience than a confident success message. The
project takes them anyway, because the alternative is a dashboard that reports
activity it cannot back up, and `spec/GOAL.md` rules out fake metrics,
testimonials, and fabricated activity outright.

The rule is simple enough to state and hard enough to keep. A run that fails is
reported as failed, with the exit code it actually had, the stderr it actually
produced, up to a documented limit, with secrets removed.

Read next: [why the approval gate comes before the container](/blog/approval-gate/).
