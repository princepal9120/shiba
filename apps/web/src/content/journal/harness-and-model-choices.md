---
title: Choosing a harness and a model per run
description: Shiba ships four coding agent CLIs in one image and makes the harness and model an explicit, validated decision on every run.
pubDate: 2026-09-16
category: guide
pattern: situation-complication-resolution
summary: A run is not just a task. It is a task plus a harness plus a model, and the combination is validated before anything executes.
---

The naive version of a coding agent has one engine. You pick a model, you wire it to a prompt, and every request goes through the same path.

Real engineering work does not look like that. Sometimes a task needs a model with a long context. Sometimes the cheapest capable model is fine. Sometimes you want to try a different agent CLI entirely, without redeploying anything. Shiba treats the harness and the model as part of the run's definition rather than as deployment constants.

<div class="callout">
<span class="callout-label">Prototype status</span>

Shiba is a local prototype. Harness configuration and egress paths are unit-tested. No measured latency, throughput, or dollar figure is claimed here, and no live cloud run is recorded.
</div>

## The situation: four CLIs, one image

The backend image ships four coding harnesses, all pinned:

- `opencode` — the default, invoked as `opencode run --format json`
- `claude-code` — invoked as `claude --print --output-format stream-json`
- `codex` — invoked as `codex exec --json`
- `devin` — Cognition's Devin CLI, invoked as `devin -p`

Aider is not implemented. Shipping them in one image is a deliberate trade: a bigger image in exchange for being able to choose per run without a deploy.

Each harness has its own output format, and each has a parser coupled to that format. OpenCode's parser, for instance, is coupled to the JSON event shape of `opencode-ai@1.18.31`. A stream-format change upstream would make a run look like it hung rather than fail, which is why the versions are pinned and why a harness CLI bump is treated as breaking.

## The complication: not every pairing works

The four harnesses do not accept the same model identifiers.

`CODING_MODEL` takes a `provider/model` value, and the value has to be one the selected harness supports. OpenCode accepts `google/*`, `anthropic/*`, and `openai/*`. Claude Code accepts `anthropic/*`. Codex accepts `openai/*`. Devin accepts `devin/*`, and it is not an AI Gateway provider at all — its CLI authenticates to Cognition's own backends with a Worker secret.

The defaults in `wrangler.jsonc` are `GATEWAY_ID: default`, `ORCHESTRATOR_MODEL: @cf/meta/llama-3.1-8b-instruct`, and `CODING_MODEL: google/gemini-3.5-flash-lite`, with `RUNTIME: sandbox`.

If you ask for a pairing the harness does not support, it is refused at config time with a message naming what the harness does support. Nothing starts, no container is provisioned, and the failure happens before approval rather than after it.

There is a related trap here. The checked-in model name is not a service guarantee. Provider model ids retire — the previous default was retired, which is why the default moved. You verify current availability in your own account; the value in the config file is a starting point, not a promise.

## The resolution: three layers of choice

The harness can be set at three different levels, and the layering is what makes this usable.

**Deployment default.** `AGENT_HARNESS` sets the fallback for the whole installation. It defaults to `opencode`. It is a default, not a lock.

**Per-surface default.** Surface-specific variables let one entry point differ from another without changing the global default. `SLACK_AGENT_HARNESS` falls back to `AGENT_HARNESS` and then to `claude-code`; `TELEGRAM_AGENT_HARNESS` and `DISCORD_AGENT_HARNESS` follow the same pattern. So Slack-originated runs can default to a different harness than dashboard runs.

**Per-run selection.** The dashboard's New Coding Task form picks the harness for an individual run. A per-run choice overrides the deployment default. When you set a per-run harness, an unsupported harness/model pair is rejected while preparing the approval — before execution, and before a container exists.

The model rides along the same way. `CODING_MODEL` can also be overridden per run, and the pairing is validated against the selected harness and the providers the gateway supports.

One boundary is worth naming. The MCP gateway tool does not accept a per-run harness or model; queued runs there use the deployment's configured defaults — `AGENT_HARNESS`, `CODING_MODEL`, and the selected harness's model default. This is a deliberate narrowing, not an oversight.

## What the choice actually costs

The honest answer is: we do not have a measured number, so we do not give you one.

The docs state no prices and make no free-use guarantees for the harnesses themselves. They point you at the platform pricing pages for Workers, Durable Objects, Containers, Workers AI, and AI Gateway, and tell you to set account budgets and alerts where supported.

What is documented is the shape of the bill. Tokens dominate inference cost by a wide margin relative to container compute, which means provider and model choice is a bigger lever than container tuning. The application also imposes its own limits — five concurrent coding runs, a fifteen-minute OpenCode timeout, a five-minute git timeout, and bounded captures for diffs and transcripts. Those are application settings, not Cloudflare plan quotas.

Two harnesses carry an extra constraint. Claude Code and Codex are API-key harnesses only. Subscription credentials are deliberately not proxied, because Anthropic's terms forbid routing requests through Free, Pro, or Max plan credentials on behalf of users. So "use my Claude subscription" is not an option, by design rather than by oversight.

The Devin harness has its own account model. It is not an AI Gateway provider; the CLI authenticates to Cognition's backends with `DEVIN_API_KEY` set as a Worker secret, and its models are `devin/<alias>` — `devin/swe-2` is the default. `DEVIN_MODEL` sets the deployment default.

## How to decide, then

If you are choosing a harness for a run, three questions are enough.

Which provider can reach the model you need through the gateway, and does the selected harness accept that provider? This is the constraint that actually blocks a run.

What is the credential situation? A harness that needs an API key needs that key configured as a Worker secret; a harness that authenticates to its own service needs its own account key. The Agents view in the dashboard lists each CLI in the image with its pinned version and credential status, which is the fastest way to see what is actually available.

What is the blast radius of the egress this harness needs? The allowlist is narrowed to the selected harness's provider host plus git, so picking a different harness changes which hosts a run can reach.

If those three line up, the run is validated and ready for approval. If they do not, the system tells you which part failed before it starts anything — which is the point of making the choice explicit in the first place.
