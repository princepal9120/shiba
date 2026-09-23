---
title: Overview
description: What AI Coworker runs today, what it returns, and which limits matter.
---

AI Coworker is an account-owned coding workspace built around a Cloudflare
Worker, durable agents, and a Sandbox container running OpenCode.
The deployed resources are declared in `backend/wrangler.jsonc`; the runtime flow is
implemented in `backend/src/agents/orchestrator.ts` and `backend/src/runtime.ts`.

<div class="docs-hero-card">
  <div class="docs-hero-icon">⚡</div>
  <div class="docs-hero-body">
    <div class="docs-hero-title">Account-Owned Autonomous Engineering</div>
    <p class="docs-hero-desc">Delegate bounded GitHub coding tasks to isolated Cloudflare micro-containers with human approval gates and secret-masking egress proxies.</p>
  </div>
</div>

## The workflow

<div class="docs-flow-grid">
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 01</div>
    <div class="docs-flow-title">Task Submission</div>
    <p class="docs-flow-desc">Describe task with repo URL and target branch via dashboard or Slack.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 02</div>
    <div class="docs-flow-title">Plan Synthesis</div>
    <p class="docs-flow-desc">Orchestrator generates bounded diff and shell commands using Workers AI.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 03</div>
    <div class="docs-flow-title">Human Sign-off</div>
    <p class="docs-flow-desc">Inspect planned commands; approve or reject on Slack or Dashboard.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 04</div>
    <div class="docs-flow-title">Sandbox Execution</div>
    <p class="docs-flow-desc">gVisor microVM clones repo, edits files, and runs test suites.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 05</div>
    <div class="docs-flow-title">Diff &amp; PR Review</div>
    <p class="docs-flow-desc">Review live syntax-highlighted diff; publish optional GitHub PR.</p>
  </div>
</div>

The delegation tool sets `needsApproval: true`. Its input contains `repoUrl`,
`task`, `baseBranch` (default `main`), and `publishPullRequest` (default `false`).
These are source contracts, not a guarantee that every generated change is correct.
Source: `backend/src/agents/orchestrator.ts`, `delegateInputSchema` and `getTools`.

## What a run returns

The sandbox runtime returns a summary, changed paths, a unified diff, captured
file contents, an exit code, and a bounded stderr tail. New files are added
with Git intent-to-add before the diff is collected.
Source: `backend/src/runtime.ts`, `runCodingTask` and `collectChanges`.

The retained run registry is smaller: it contains status, task metadata,
timestamps, and optional summary or error. Files and diffs belong to the
transcript, not the registry response. See [Dashboard](/docs/dashboard/).
Source: `backend/src/runs.ts`, `DelegatedRun`; `backend/src/transcript.ts`.

## Ownership and exposure

Treat one installation as **single-tenant and account-owned**. Cloudflare
Access or equivalent authentication is required before exposing it to a team
or the public internet. An obscure Worker URL is not access control.
This is the deployment requirement in `spec/GOAL.md`, not authentication
implemented by `backend/src/index.ts`. Read [Security](/docs/security/) first.

## Current behavior (as implemented)

Sandbox is the working runtime adapter. The `computer` adapter deliberately
refuses execution. OpenCode is configured with a dummy container key; the
real provider credential is swapped in at Sandbox egress. There is no public
provider callback. Private Git clone still uses HTTPS without a clone-time
token; path-scoped `GITHUB_TOKEN` is attached only for the approved repo.
Sources: `backend/src/runtime.ts`, `backend/src/egress.ts`, `backend/src/agents/opencode-agent.ts`.

## Specification target (GOAL)

`spec/GOAL.md` additionally calls for Sandbox HTTPS interception for provider
and Git transport traffic, plus retained-registry gating of child routes.
Those are not guarantees of the current implementation. The distinctions are
explained in [Architecture](/docs/architecture/) and [GitHub](/docs/github/).

## Next steps

Start with [Getting started](/docs/getting-started/), then set the
[Configuration](/docs/configuration/). Use
[Local development](/docs/local-development/) before
[Deployment](/docs/deployment/).
