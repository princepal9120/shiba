---
title: Why self-host a coding agent at all
description: Self-hosting a coding agent only matters if the harness, the model, and the account are all yours, because that combination is what the seat fee never buys.
pubDate: 2026-09-19
category: note
pattern: what-is-what-could-be
summary: What self-hosted usually means, what it could mean, and the three belongings that decide which one you actually get.
---

This is a note about a phrase. Self-hosted gets attached to a lot of software
that hands you the container and keeps the leverage. Shiba is built around a
stricter reading, and it is worth writing down what that reading is.

Sources: `README.md`, `PLAN.md`, `spec/GOAL.md`, and `design.md`. Shiba
is a local prototype, so this note describes an architecture and a position,
not a verified live cloud run.

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Shiba's own status is local prototype, not production-ready. Everything
  below is what the code and plan are built to do, checked against tests and
  typechecks, not a claim about a live service.</p>
</div>

## What self-hosted usually means

The usual offer is a binary. Run the vendor's agent on your machines, keep
your repos on your side, and call it self-hosted.

`PLAN.md` names the two reference points directly. Capy locks you to Capy's
agent. Hoplite gives you theirs in the cloud or your own on your laptop,
never your own in the cloud. Neither lets a team run their harness on their
account against their model.

That is the gap. You can self-host the workload and still rent the judgment.
The agent's identity, the model it thinks with, and the account it bills to
stay on the vendor's side of the line.

## The three belongings

The plan reduces the whole argument to one sentence: without the combination,
self-hosted saves a seat fee and nothing else. The combination is three
things.

Your harness. Shiba's runs execute OpenCode or Claude Code inside a
sandboxed container. The coding agent is a tool the run invokes, not the
product's identity, so the harness is a per-run choice with its own model
routing.

Your model. The provider is configurable, and the bring-your-own-key path is
load-bearing rather than cosmetic. You add a provider key to the AI Gateway
named `default`, and the egress boundary does the rest: real credentials
are injected at the gateway, the container only ever sees a dummy key.

Your account. The whole workspace is a Cloudflare account you own. The
Worker, the Durable Objects, the queue, the approval records, and the
sandbox containers all live there. So do the approver lists. The gate's
authority is yours because the infrastructure holding it is yours.

## Why the model leg carries weight

The plan is blunt about the alternative. If users are locked to one
provider, the self-hosted pitch saves the subscription and nothing else. The
vendor still decides what the agent is.

It is equally blunt about a tempting shortcut. Anthropic's OAuth terms allow
ordinary use; third parties routing requests through Free, Pro, or Max
credentials on behalf of users is a different matter. Self-hosted use of
your own subscription is grayer, but shipping that as a documented feature
means facilitating it, and the person who loses a plan is your user. So
Shiba ships the configurable provider instead and lets you point it wherever
you want.

That is a slower road. It is also the only one where the model leg is
actually yours rather than borrowed under terms someone else wrote.

## Why I am building it

The motivation is personal before it is strategic. I have used Devin, and I
run my own Claude Code setup daily. Devin's coding quality is genuinely
good, and that is exactly the problem: the quality made the tradeoffs
visible, not the flaws.

What I wanted was narrower than what any single tool sells. I wanted to
pick the harness and the model per task, because different tasks deserve
different combinations and no vendor defaults them the way I would. I
wanted the runs to live in my own Cloudflare account, where the records,
the bills, and the approval lists are mine to inspect. And I wanted to see
the work and the failures directly — the diff, the exit code, the bounded
stderr tail — rather than trust a hosted verdict about either.

Shiba is what those three wants look like as code. It is also a prototype,
and it behaves like one: the architecture holds, the verification record is
honest about its level, and the rest is still being built.

## What it could be

What is: a local prototype. Submit a task, hold it at a gate, dispatch to a
sandbox, collect a diff, report failures honestly. The static site, the
dashboard UI, and the docs are deployed; the backend is verified to the
level the verification record states, no further.

What could be: a team running its own harness, on its own cloud account,
against its own model, with every approval decided by people it names. Not a
self-hosted binary under a hosted brain. The whole loop, owned.

The honest gap between those two paragraphs is the product. The differentiator
only exists if all three belongings hold at once; lose any one and you are
back to renting something with extra steps.

## What it costs

Self-hosting costs you the account. You provision the gateway key, create
the Slack app from the manifest, mint the MCP token, and name your
approvers. Email routing needs a domain on Cloudflare.

It also costs you the ceiling. The sandbox size is documented at standard-4:
four vCPU, twelve GiB of memory, twenty GB of disk. Nobody should discover
that on a monorepo, so it is stated up front.

And it costs you the status. A prototype you own is still a prototype. The
plan keeps the phrase local prototype until a dated acceptance run replaces
it, because self-hosted honesty beats hosted confidence.

That is the trade. More setup, more responsibility, a hard resource ceiling,
and in exchange the three belongings stay on your side of the line.

## What ownership buys when things break

The boring payoff shows up on a bad day. When a run fails, the evidence lives
in your account: the approval record, the run status, the structured result
envelope, the bounded stderr tail. `run_status` and `list_runs` read back
records your own infrastructure holds, scoped to the token that queued them.

There is no vendor status page to refresh and no support queue between you
and the log. The failure contract — real exit code, bounded tail, error
envelope, no fake success — is only trustworthy if you can check the
underlying records, and you can only check them if they are yours.

Self-hosting does not make failures rarer. It makes them legible, and that
legibility is the point of owning the infrastructure in the first place.

Read next: [harness and model
choices](/blog/harness-and-model-choices/).
