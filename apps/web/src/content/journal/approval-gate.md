---
title: The approval gate is the product
description: Why Shiba stops at a human checkpoint before it clones a repo, runs a shell command, or pushes a branch.
pubDate: 2026-09-14
category: guide
pattern: protagonist-arc
summary: The gate is not a confirmation dialog bolted on later. It is the reason the rest of the system is allowed to exist.
---

Shiba is a coding agent. It clones a repository, runs commands inside a container, and can open a pull request. Every one of those actions is reversible in theory and expensive in practice. The interesting engineering question is not whether the agent can do the work. It is how the system earns the right to try.

The answer in this codebase is a human gate, and the gate is treated as the central safety invariant rather than a feature.

<div class="callout">
<span class="callout-label">Prototype status</span>

Shiba is a local prototype. The gate is implemented and unit-tested. No live end-to-end cloud run is recorded, so nothing here is a claim about deployed behaviour.
</div>

## The workflow that keeps walking toward the edge

Start with a plain request. Someone types a task into the dashboard, or mentions the bot in Slack. From there a documented path runs forward.

The `CodingOrchestrator` is the planning agent. It does not edit repositories. Its job is to turn prose into a structured `delegate_coding_task` tool call carrying four fields: `repoUrl`, `task`, `baseBranch` (default `main`), and `publishPullRequest` (default `false`).

That tool is declared with `needsApproval: true`. This is the point where the run stops. No sandbox is provisioned. No clone happens. The system has a complete, machine-readable intent, and it is sitting on a desk waiting for a person.

The reason the pause lands here rather than later is ordering. Approving a plan is cheap. Approving a container that has already run `pnpm install` is archaeology. The gate is placed as early as the design allows, so the human decides while the decision is still reversible.

## What the reviewer actually sees

A gate that shows a spinner is theatre. The approval surfaces show the specific facts a reviewer needs in order to say no.

The self-hosted dashboard at `/app` lists the target repository and branch, the planned shell commands, and an estimated compute duration, with one-click **Approve** and **Reject with Reason** actions. Buttons route through `addToolApprovalResponse`, so the decision is recorded against the tool call rather than inferred from ambient UI state.

Slack gets the same treatment as a Block Kit card posted into the originating thread: a delegation plan, the target branch, the planned commands, an **Approve Run** button, and the run identifier. Clicking it resolves on the Durable Object named by the card pointer and unblocks the workflow, which is what provisions the Sandbox container.

There is a third path for pipelines. `POST /api/runs/run_01a0b4cd/approve` with a bearer token submits a decision programmatically. Same gate, different surface.

Read together, these surfaces answer the same four questions: which repository, which branch, which commands, and how much compute. A reviewer who cannot answer those cannot meaningfully approve.

## What rejection actually does

The unhappy path is the one that gets designed carefully. On rejection, the reason is recorded in `CodingOrchestrator`, container provisioning is aborted, the team is notified, no container is launched, and no git change is made. Not "the agent is told to stop" — no container, no branch, no diff.

That property is also why the Slack approval list is deny-by-default. `SLACK_APPROVERS` unset means nobody can approve from Slack. A valid Slack signature authenticates that the request came from Slack; it does not authenticate which human clicked the button. In a public channel, every member can click. Failing closed is the only honest default there.

Automations follow the same rule. Scheduled and webhook-triggered runs queue an approval like any other. Unattended mode exists but is refused unless opening a pull request is the only mutation and the repository is on an explicit allowlist, and it still carries a daily run budget.

## The four things it is protecting

The docs name the failure modes the gate exists to catch, and they are ordinary engineering failures rather than exotic attacks.

**Destructive commands.** An agent that decides to run something irreversible should have to explain itself first. Inadvertent `rm -rf`, branch force-pushes, and schema drops are all in scope for this review.

**Dependency provenance.** Adding a package is adding code. The reviewer is the point where "did this come from a trusted registry" gets asked out loud.

**Scope creep.** A request to fix input sanitisation in one file should not quietly become a refactor. The gate shows the target branch and the planned commands, which is exactly the evidence needed to notice drift.

**Cost.** Containers and inference are billed. A review point before a heavy task launches is a real cost control, and the dashboard shows estimated compute duration at the moment of decision.

None of this eliminates risk. A human can approve a bad plan, and a good plan can still fail. The claim is narrower and more useful: the system refuses to act unilaterally on anything irreversible, and it makes the reviewer responsible for a specific, checkable set of facts.

## Why it comes first in the design

Retrofitting a gate is unpleasant. You end up auditing an agent that already had shell access, and every finding becomes an argument about how much to restrict. Building the gate first means the destructive capability was never available on its own terms.

The same ordering shows up in the credential boundary: provider keys never enter the container, and `GITHUB_TOKEN` is attached by the Worker at egress rather than handed to the process. The gate and the credential boundary are the same idea applied to two different risks — keep irreversible authority outside the thing you are gating.

If you take one thing from the Shiba codebase, take this: the interesting part of an autonomous agent is not its autonomy. It is the list of things it is structurally not allowed to do on its own, and the fact that a person is standing at exactly that boundary.
