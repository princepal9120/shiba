---
title: "An open-source coding agent alternative: a guide to Shiba"
description: A grounded look at Shiba as an open-source alternative to hosted coding agents, covering what is inspectable, what is gated, and what is not yet proven.
pubDate: 2026-09-20
category: guide
pattern: situation-complication-resolution
summary: What the search for an open-source coding agent usually means, what Shiba actually is, and how to evaluate it against your own work.
---

![Glass terminal console with holographic diffs floating above it](/blog/open-source-coding-agent-alternative.png)

Searching for an open-source alternative to a hosted coding agent returns a
mix of projects, and this is a guide to one of them. We build Shiba, so this
guide explains our approach and its limits. It is not a benchmark, not a
claim of feature parity, and not a live run we can show you.

Sources: `README.md`, `PLAN.md`, `spec/GOAL.md`, `VERIFICATION.md`,
and `design.md`. We have not run a controlled comparison against hosted
products, so nothing below claims relative speed, success rate, or cost.

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Shiba is a local prototype, not production-ready. The deployed site
  carries the landing page, dashboard UI, and docs. The Worker backend is
  verified by typecheck, lint, tests, and build, plus one dated local run
  that reached the model call. No live end-to-end cloud run is claimed.</p>
</div>

## What the search usually means

"Open-source coding agent alternative" bundles several different
requirements: readable source, a choice of agent harness, a model you pick,
infrastructure you own, or a checkpoint before anything executes. They
overlap but they are not interchangeable, so write down the one that matters
most before comparing projects.

If the requirement is source inspection, start at the repository and the
license. If it is remote execution, check what the backend actually runs on
and who owns that account. If it is safety, look for where a human decision
is required and whether that checkpoint is code or policy.

A tool can match your preferred interface and still be wrong for the
environment your project needs. The honest comparison is between your
written requirement and evidence you can reproduce on your own machine,
not between two homepages.

## What Shiba is

Shiba is an open-source, self-hosted AI software engineer. The repository is
AGPL-3.0-only, and it is a pnpm monorepo holding a React dashboard, an
Astro documentation site, and a Cloudflare Worker backend built around
Agents and Sandbox containers. You describe a GitHub task, review the
proposed delegation, approve or reject it, and inspect the diff the sandbox
produced.

Source access is useful here because the safety claims live in code. Which
operations need a human, what state the run retains, and what secrets can
reach the container are all readable. Record the revision you evaluated so
your findings stay attached to a specific implementation.

## Choose the harness and the model

A Shiba run executes OpenCode or Claude Code inside a sandboxed container.
The coding agent is a tool the run invokes, not the product's identity, and
`CODING_MODEL` is a per-run selection.

Model access goes through a Cloudflare AI Gateway in your account. You add a
provider key to the gateway named `default`, and the container only ever
sees a dummy key. The gateway holds the credential; the sandbox never does.

That separation is the open-source case. A self-hosted binary pointed at a
vendor's locked model saves the seat fee and nothing else. The harness, the
model, and the account all need to be yours at once.

## The approval gate is the feature

Hosted agents differ on where the human sits. In Shiba the rule is code: no
sandbox starts before a human approves the exact tool input. Approvals
resolve in the dashboard, on an iPhone home-screen app, or on a Slack card.
The MCP surface has `queue_run` and `run_status` but no approve tool, so
a queued run cannot approve itself.

Automations get the same treatment. Cron, GitHub, Slack, webhook, and manual
triggers all queue an approval by default. Unattended mode exists only for
pull-request-only mutations on an explicit repo allowlist.

## Compare against your actual requirements

| Requirement | Shiba's approach | What to verify |
|---|---|---|
| Inspectable source | AGPL-3.0 monorepo, three apps | The revision you plan to run |
| Harness choice | OpenCode or Claude Code per run | Authentication in your environment |
| Model choice | BYOK through your AI Gateway | Provider key in gateway `default` |
| Approval before execution | Required human gate, code-enforced | Approval list and entry points |
| Failure reporting | Real exit code, bounded stderr tail, error envelope | A failing task's record |
| Compute ceiling | `standard-4`: 4 vCPU / 12 GiB / 20 GB | Your build's actual footprint |

A missing row is a reason to keep looking, not a reason to assume a
workaround. The compute ceiling is real: heavy builds and large monorepo
test suites are out of reach on this platform by design.

## Run one bounded check before trusting it

Clone the repository and run the same commands the project verifies itself
with: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. A
`wrangler deploy --dry-run` exercises the backend shape further if you
have a compatible container engine.

Read `VERIFICATION.md` before deciding anything. It is dated, it labels
what was checked, and it records the failures alongside the passes. A
prototype whose verification file admits what it could not check is easier
to trust than a polished demo you cannot reproduce.

## When Shiba is a fit to evaluate

Shiba fits when you want the approval gate, the egress boundary, and the
harness-model-account combination, and you can accept the standard-4
ceiling and a prototype's evidence level. It does not fit when you need a
production service today, bigger machines, or a managed vendor to
operate.

Read next: [why self-host a coding agent at
all](/blog/why-self-host-a-coding-agent/) and [approvals in Slack, not
another dashboard](/blog/approvals-in-slack-not-another-dashboard/).
