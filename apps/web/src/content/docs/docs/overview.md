---
title: Overview
description: What AI Coworker runs today, what it returns, and which limits matter.
---

AI Coworker is an account-owned AI coding-task service built around a Cloudflare
Worker, Durable Objects, and Sandbox containers. OpenCode is the default harness;
OpenCode, Claude Code, Codex, and Devin are implemented harness choices.
The deployed resources are declared in `apps/backend/wrangler.jsonc`; the runtime flow is
implemented in `apps/backend/src/agents/orchestrator.ts` and `apps/backend/src/runtime.ts`.

<div class="docs-hero-card">
  <div class="docs-hero-icon">⚡</div>
  <div class="docs-hero-body">
    <div class="docs-hero-title">Account-Owned Autonomous Engineering</div>
    <p class="docs-hero-desc">Queue bounded GitHub coding tasks for human approval and isolated Sandbox execution.</p>
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
    <p class="docs-flow-desc">The request is queued with its repository, task, and execution options for approval.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 03</div>
    <div class="docs-flow-title">Human Sign-off</div>
    <p class="docs-flow-desc">Approve or reject the queued request through the supported approval surface.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 04</div>
    <div class="docs-flow-title">Sandbox Execution</div>
    <p class="docs-flow-desc">The selected harness runs in a Cloudflare Sandbox container after approval.</p>
  </div>
  <div class="docs-flow-step">
    <div class="docs-flow-num">STEP 05</div>
    <div class="docs-flow-title">Diff &amp; PR Review</div>
    <p class="docs-flow-desc">Review captured changes; optional GitHub publishing is separate from execution.</p>
  </div>
</div>

The delegation tool sets `needsApproval: true`. Its input contains `repoUrl`,
`task`, `baseBranch` (default `main`), and `publishPullRequest` (default `false`).
These are source contracts, not a guarantee that every generated change is correct.
Source: `apps/backend/src/agents/orchestrator.ts`, `delegateInputSchema` and `getTools`.

## What a run returns

The sandbox runtime returns a summary, changed paths, a unified diff, captured
file contents, an exit code, and a bounded stderr tail. New files are added
with Git intent-to-add before the diff is collected.
Source: `apps/backend/src/runtime.ts`, `runCodingTask` and `collectChanges`.

The retained run registry is smaller: it contains status, task metadata,
timestamps, and optional summary or error. Files and diffs belong to the
transcript, not the registry response. See [Dashboard](/docs/dashboard/).
Source: `apps/backend/src/runs.ts`, `DelegatedRun`; `apps/backend/src/transcript.ts`.

## Ownership and exposure

Treat one installation as **single-tenant and account-owned**. Cloudflare
Access or equivalent authentication is required before exposing it to a team
or the public internet. An obscure Worker URL is not access control.
This is the deployment requirement in `spec/GOAL.md`, not authentication
implemented by `apps/backend/src/index.ts`. Read [Security](/docs/security/) first.

## Current behavior (as implemented)

Sandbox is the implemented runtime adapter. Harnesses selectable in current
source are OpenCode, Claude Code, Codex, and Devin; the default is OpenCode.
Harness tests cover configuration/argv, provider allowlists, event parsing,
and selection, but do not prove end-to-end CLI success. `VERIFICATION.md`
records a local OpenCode run on 2026-09-19 that reached provider egress and
failed with 401 before inference. It records no cloud end-to-end run; no local
or cloud end-to-end run is recorded for Claude Code, Codex, or Devin. Private
Git clone uses HTTPS without a clone-time token; `GITHUB_TOKEN` is for the
optional publisher, not clone authentication.
Sources: `apps/backend/src/runtime.ts`, `apps/backend/src/egress.ts`, `apps/backend/src/agents/opencode-agent.ts`.

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
