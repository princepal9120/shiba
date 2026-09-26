---
title: Choosing a harness and a model for a run
description: How Shiba lets you pick the coding CLI and the model per run, and what it refuses to do with that choice.
pubDate: 2026-09-16
category: guide
pattern: situation-complication-resolution
summary: Four coding CLIs ship in one image. The choice is yours per run, and the wrong pairing is refused before anything starts.
---

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Shiba is a local prototype. No live end-to-end cloud run is claimed. This post makes no claim about latency, cost, or savings from any model or harness choice; use your own account's current pricing and limits.</p>
</div>

Coding agents are not interchangeable, and pretending otherwise is how a system ends up with four half-wired integrations. Shiba takes a narrower, more honest position: ship four real CLIs in one image, let the person filing the task pick per run, and be explicit about which of them have actually been exercised.

## The situation: one container, four tools

The container image installs four coding harnesses: OpenCode, Claude Code, Codex, and the Devin CLI. They are not adapters around one engine — they are four separate command-line programs with four different argv conventions, four config-file formats, and four different streaming event formats. The image build fails unless every installed binary reports its version.

Choosing to support them in one image rather than one image per harness is a real trade. It means a single pinned base image carries more weight, and the version matrix is coupled: a harness CLI upgrade is a breaking change, because the event parser is written against that CLI's specific stream shape.

The upside is that switching harnesses is a dropdown, not a redeploy.

## The complication: a model id is not a free choice

Each harness supports a different set of providers, and the model is named as `provider/model`. OpenCode spans `google/*`, `anthropic/*`, and `openai/*`. Claude Code is `anthropic/*`. Codex is `openai/*`. Devin is `devin/*` and is not an AI Gateway provider at all — its CLI authenticates to Cognition's own backends with a service key.

So "pick any model" is not quite the offer. The offer is: pick a model the *selected* harness actually supports, or the run is refused.

That refusal happens at configuration time, and the error message names what the harness does support. It is not a late failure inside a container that has already spun up and already consumed minutes of your account.

## The resolution: a per-run selector, validated before approval

The dashboard's New Coding Task form carries the harness and model choice. The approval record freezes them alongside the repository, task, and branch, so the human sees exactly what was selected before approving.

The validation lands at a specific point in the lifecycle: while the approval is being prepared. An unknown harness, or a harness/model mismatch, fails there. By the time a container could exist, the pairing is already known-good. You never approve a plan and then discover it was incoherent.

Per-run selection overrides the deployment default. `AGENT_HARNESS` is only the fallback for runs where nobody chose otherwise.

## What each harness actually is

**OpenCode** is the default. Multi-provider, invoked with a JSON output format, and the only harness that has completed a dated local end-to-end exercise — though that run reached the provider and returned a 401 at the model call, so inference itself was not verified.

**Claude Code** runs with a print/stream-JSON output format and takes `anthropic/*` models. **Codex** uses its own JSON exec format and `openai/*` models. **Devin** uses the Cognition CLI with a `devin/*` model alias and its own service credential.

The important qualifier, stated in the docs: only OpenCode has been run live. The other three CLIs ship in the image, their configuration, argv, environment, and event parsers are unit-tested against their documented stream formats, and the Dockerfile verifies each binary reports a version at build time — but that is a build check, not an end-to-end test. A stream-format drift in an unexercised harness would surface at its first real run.

## The model id is a moving target

The default coding model is a fast, cheap-tier model, and the repository pins it. The pin exists for a reason: model ids retire without warning. An earlier default was shut down on a fixed date, which is why the default moved, and why a retired model id is now actively refused at startup rather than failing later inside a run.

The checked-in model name is a convenience, not a service guarantee. Current availability depends on your account, and you should verify it there. The completion plan is explicit that re-running the full acceptance pass is required before claiming a bumped pin works.

## Cost, honestly

The costs documentation names its surfaces — Workers requests, planning inference, Durable Objects, Containers, provider inference through your gateway arrangement, and GitHub quotas — and then declines to quote numbers, because a quoted number ages badly and a wrong one is worse than none.

It also declines the earlier cost-ratio claim that has circulated in this repository's own history, on the grounds that the ratio was not evidenced in the dated verification record. What it says instead: set budgets and alerts in your own account, and read your provider's current pricing. The one durable point is that token usage, not container tuning, is what tends to dominate a coding run's bill — so provider and model choice is the lever worth thinking about, and the size of that lever is something you should measure against your own usage rather than take from a blog post.

## The platform ceiling, stated once

Whichever harness you pick, it runs on Cloudflare Containers, which top out at a fixed instance size. Heavy builds and large monorepo test suites are out of reach on this platform by design, and the documentation says so rather than leaving you to discover it. If your task is "run the full test suite," no harness choice will save it.

## What this comes down to

Picking a harness and a model in Shiba is a form field with a validator behind it, and that is the honest version of the feature. It does not pretend four CLIs are interchangeable, it refuses incoherent pairings before you approve them, and it tells you which one has been proven and which three have only been wired. The next time a model id retires or a CLI changes its stream format, you will find out from a clear error, not from a container that appears to hang.
