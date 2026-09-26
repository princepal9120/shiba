---
title: The approval gate, and what it is actually protecting
description: Why a self-hosted coding agent stops before every container, and what breaks if that stop is removed.
pubDate: 2026-09-14
category: guide
pattern: protagonist-arc
summary: The approval gate is not a confirmation dialog. It is the only thing standing between a model and a shell.
---

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Shiba is a local prototype. No live end-to-end cloud run is claimed, and no user count, success rate, benchmark, latency, or cost saving is asserted anywhere in this post. Everything described here is traceable to the repository's own specification, plan, and dated verification record.</p>
</div>

Most "human in the loop" features are a checkbox in a settings page. Shiba's is the product contract.

The specification in `spec/GOAL.md` puts it as product step seven: a user enters a GitHub repository URL and a coding task, and then *reviews an approval card before any sandbox execution starts*. Not after. Before. The same file then requires the delegation tool to declare `needsApproval: true`, and states the rule in one sentence that leaves no room for interpretation: no sandbox starts before the human approves the exact tool input.

That is worth unpacking, because "approve the exact tool input" is doing a lot of work.

## The workflow that reaches the gate

Read the sequence in the specification as a story with a shape.

1. A person describes a task against an HTTPS GitHub repository.
2. A planning orchestrator turns that prose into structured input — a repository URL, a task, a base branch that defaults to `main`, and a pull-request flag that defaults to false.
3. That structured input is frozen into a pending approval record.
4. A human sees it, and approves or rejects.
5. Only then does an isolated container exist, clone the base branch, run the coding harness, and produce a diff.

The orchestrator never edits repositories itself. It plans and it delegates. The separation matters: the component that interprets an ambiguous human request is not the component holding a shell.

Slack is a second door into the same room. The specification treats the dashboard as one inbound surface of two. Mentioning the bot in a thread, or using the slash command, produces the same pending approval and the same card before any container starts.

## What the gate stops

The documentation for approval gates names four risks, and they are worth reading as a list of things that are otherwise indistinguishable from normal work:

- **Destructive commands.** An agent that legitimately needs a shell will also happily run whatever the task text led it to. `rm -rf`, a force-push, a dropped schema — all look like progress in a transcript.
- **Dependency ingestion.** A new package in a manifest is a remote code execution decision made by something that read a file.
- **Scope creep.** The agent edits the file you asked about, and then the neighbouring file, and then the test that was going to fail anyway.
- **Cost.** A container that runs for fifteen minutes at the platform ceiling is a bill. A human sees the plan before that starts.

The common thread is that none of these announce themselves. A destructive command and a correct one produce the same shape of output. The gate is the only point where a person can still say no.

## Approval is of input, not of a summary

The subtle design decision is that the human approves *the exact structured input that will execute*, never a prose rendering of it.

A summary is a lossy channel. "Will fix the sanitization bug in the auth module" is accurate and useless — it does not name the branch, and it does not say whether a pull request will be opened. The frozen input does. This is why the approval record persists the delegation input itself: `repoUrl`, `task`, `baseBranch`, `publishPullRequest`, and — since per-run selection landed — the harness and coding model.

The harness detail sharpens the same point. An unknown harness, or a harness paired with a model that harness does not support, fails *while the approval is being prepared*. It does not surface inside a container a human already clicked approve on.

## Slack has a second gate, and it is easy to miss

The Block Kit card is the visible half of the Slack path. The invisible half is the approver allowlist.

The repository documentation is blunt about why: a valid signature authenticates Slack, not the human who clicked. A Block Kit button in a public channel is clickable by every member of that channel. So the flow gates twice — the request must carry a valid Slack signature, *and* the clicker must be on the allowlist. An unset allowlist means nobody can approve from Slack. That is a deliberate default, not a configuration mistake.

## Automations are the same gate with nobody standing at it

An automation schedules work. It does not authorize work. Scheduled runs queue an approval like anything else.

The opt-in exists, and it is narrow on purpose. Unattended mode is granted only when opening a pull request is the run's *only* mutation and the repository is on that automation's explicit allowlist. The reasoning is that a pull request is reviewable and revertible; deleting a branch is not. A daily run budget per automation bounds the other obvious failure — a cron typo burning tokens until somebody notices the invoice.

There is also a cheap gate in front of those. An automation can carry a plain-language `run_when` condition, checked before the run starts. It fails closed: a model error, an empty answer, or anything not clearly affirmative means no run, and the reason is recorded rather than dropped.

Kill switches exist at two levels — `enabled` per automation, and a global var — for the case where a schedule has drifted from what its author intended.

## Rejection is a real outcome

Worth stating plainly, because systems that only model success quietly coerce everyone into approving: rejecting a plan records the reason, aborts container provisioning, and starts no container. No git changes are made. The run is not "pending forever."

The acceptance criteria in the completion plan are stricter than the UI, deliberately. Rejection has to *provably* start no container — measured in container metrics, not inferred from the absence of a success badge. The reason is obvious once stated: a UI that says "nothing happened" and a system that quietly started a container anyway are the same interface, and only one of them is safe.

## The honest limit

The approval gate is the best-evidenced safety property in this repository, and it is still not the same thing as a proven deployment. The documentation says so directly: this is implementation and test coverage, not a cloud penetration-test result, and it does not prove that a deployed hostname is covered by the intended Access application.

The same caution applies to the gate itself. The unit tests prove the approval requirement holds in the paths they exercise. A dated live run against the plan's own acceptance bar — including the container-metric proof that rejection starts nothing — is not recorded, and the plan says so rather than implying otherwise.

## Why this is the spine

The completion plan lists what to keep, what to cut, and what to unlock. The approval gate is in the first list, above the fixes, above the features, above the differentiator.

That ordering is the argument. The gate is what makes it reasonable to hand an agent a repository at all. Everything else — four harnesses, Slack, automations, pull requests — is a way of reaching the gate more often. Remove the gate and none of it is a product; it is an unattended shell with a nice dashboard.

Next: what actually crosses the boundary when the gate opens, and what deliberately does not.
