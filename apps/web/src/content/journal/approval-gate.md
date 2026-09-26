---
title: Why the approval gate comes before the container
description: Shiba stops a planned coding run at a human decision point, and that gate is the safety invariant the rest of the system is built around.
pubDate: 2026-09-14
category: guide
pattern: protagonist-arc
summary: A planned run reaches an irreversible step, a human holds it, and the gate decides what happens next.
---

The subject of this post is a pause. A coding agent has a plan, the plan needs
shell access and a git push, and something in the middle says not yet. That
something is the approval gate. This is a guide to why it sits where it sits
and what it protects.

Everything here traces to files in this repository: `spec/GOAL.md`,
`apps/web/src/content/docs/docs/approval-gates.mdx`, and `CLAUDE.md`. Shiba is a
local prototype. Nothing in this post describes a verified live cloud run.

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>The gate is covered by unit tests. <code>VERIFICATION.md</code> lists a live
  cloud run as not attempted, so treat the behaviour below as locally verified
  code, not as a deployment claim.</p>
</div>

## The agent that never edits

`CodingOrchestrator` is described in `spec/GOAL.md` as a planning and
delegation agent. It never edits repositories itself. It takes structured input
through a `delegate_coding_task` tool: `repoUrl`, `task`, `baseBranch` with a
default of `main`, and `publishPullRequest` defaulting to `false`.

The goal file then names the mechanism. The delegation tool must use AI SDK
`needsApproval: true`. And it states the rule in one line: no sandbox starts
before the human approves the exact tool input.

That is the shape of the whole system. The orchestrator produces intent. It does
not act on it. A human moves intent into action, or does not.

## What the gate is protecting

`approval-gates.mdx` calls approval gates the central safety invariant and says
autonomous agents are never permitted to clone private code, execute terminal
commands, or push git branches without explicit human verification.

The document lists four risks the gate is aimed at.

- **Destructive commands.** Preventing an inadvertent `rm -rf`, a branch
  force-push, or a schema drop.
- **Malicious dependency ingestion.** Verifying that new packages come from
  trusted registries.
- **Scope creep.** Keeping edits to the requested feature or bugfix.
- **Cost controls.** Reviewing projected compute and token usage before a heavy
  task launches.

Read those together and the gate is not a single feature. It is a review point
for four different failure modes: the destructive one, the supply-chain one, the
drift one, and the expensive one.

## The moment the run stops

Someone submits a task. The orchestrator drafts a delegation plan. Then the run
halts in a pending state, waiting.

`VERIFICATION.md` describes what the local path does at that point. A local
approval creates an `approvalId` and persists a pending approval in the
`default` orchestrator Durable Object. A signed Slack approval resolves exactly
once. Only then is the child and container dispatched.

Three synchronous channels can carry the decision, per `approval-gates.mdx`.

Slack sends a Block Kit card to the originating thread, showing the delegation
plan, the target branch, the planned commands, and an `Approve Run` button. The
dashboard at `/app` shows the target repository and branch, the planned shell
commands, an estimated compute duration, and `Approve` or `Reject with Reason`.
For pipelines, `POST /api/runs/{run_id}/approve` takes a bearer
`${ADMIN_API_KEY}` and a JSON body with `approved` and `reviewer`.

Whichever channel is used, the person approving sees the plan rather than a
summary of it afterwards.

## The resolution

Approve, and the Durable Object workflow unblocks and provisions the container.
Reject, and the orchestrator records the reason, aborts provisioning, and
notifies the team. No container launches. No git changes are made.

That asymmetry is the point. The reject path is not a soft failure. It is a
complete stop, and it is a supported, normal outcome rather than an error.

`spec/GOAL.md` also constrains who may approve. Only `SLACK_APPROVERS` can
approve from Slack, and an empty approver list means nobody can. `README.md`
explains the reasoning: a valid signature authenticates Slack, not the human
who clicked, and a button in a public channel is clickable by everyone in it.

There is an unattended mode, and it is narrow by design. Automated runs require
approval by default. Unattended execution is limited to pull-request-only
mutations on an explicit repository allowlist. `README.md` lists three
conditions that must hold together: approval by default, unattended mode
refused unless opening a PR is the only mutation and the repo is allowlisted,
and a daily run budget per automation. It also notes this path is not verified
live.

## The parts that cannot skip it

Automations do not get a private door. `VERIFICATION.md` states that
quality-gate cards queue through the same `POST /api/runs` approval path, with no
bypass, because a human still approves before a container starts.

Configuration problems surface at the same point. `VERIFICATION.md` records
that harness and model mismatches fail on the approval card, never inside a
container the human already approved. Approval preflights the concurrency cap,
the token, and the URL before it consumes the run pointer, so a rejected
preflight stays retryable with a `409`.

## Limits of this account

These are code-level and unit-tested behaviours, not deployment proof.
`VERIFICATION.md` lists a live cloud run as not attempted, and `claude-code.mdx`
is explicit that its harness tests do not prove the CLIs can complete a task end
to end. Security requirements in `spec/GOAL.md` are written as things the system
must do, including no claim of full multi-tenant isolation.

What is verified locally is the gate itself: approval required by default,
refusal of unattended non-allowlisted or non-PR mutations, kill switches, and
approver allowlisting.

## Why it is the centre

An agent that can run shell commands and push branches can do real damage before
anyone notices. A gate placed after execution documents a failure. A gate placed
before it prevents one.

The rest of Shiba is built around that ordering: credentials stay outside the
container, failures report real exit codes, and the dashboard shows no invented
activity. The approval gate is the piece that makes those boundaries mean
something, because it is the last point where a person is still in control.

## Why this is the spine

The completion plan lists what to keep, what to cut, and what comes last. The approval gate is in the first list, above the fixes, above the features, above the differentiator.

That ordering is the argument. The gate is what makes it reasonable to hand an agent a repository at all. Everything else — four harnesses, Slack, automations, pull requests — is a way of reaching the gate more often. Remove the gate and none of it is a product; it is an unattended shell with a nice dashboard.

Next: what actually crosses the boundary when the gate opens, and what deliberately does not.
