---
title: Harness and model choices, and what they do not tell you
description: Shiba lets each run pick a coding harness and model, refuses bad pairings before execution, and publishes no cost or latency numbers.
pubDate: 2026-09-16
category: guide
pattern: situation-complication-resolution
summary: The situation is a per-run choice, the complication is that nobody has measured the outcome, and the resolution is to publish limits instead of claims.
---

This post is a situation, a complication, and a resolution. It is about how you
pick a coding harness and model for a run in Shiba, and about why the
accompanying documentation refuses to tell you which option is faster or
cheaper.

Sources: `README.md`, `apps/web/src/content/docs/docs/claude-code.mdx`, and
`apps/web/src/content/docs/docs/costs.md`. Shiba is a local prototype. No live
end-to-end cloud run, benchmark, latency figure, or dollar saving is claimed
here.

<div class="callout">
  <span class="callout-label">Prototype status</span>
  <p>Harness selection is unit-tested. The one recorded local end-to-end
  exercise returned a 401, so no successful model call is claimed for any
  harness, and no cost or latency comparison appears in this post.</p>
</div>

## The situation: two dials

Shiba ships four coding harnesses in one pinned image: `opencode` (the default,
invoked as `opencode run --format json`), `claude-code` (`claude --print
--output-format stream-json`), `codex` (`codex exec --json`), and `devin`
(`devin -p`, Cognition's Devin CLI). Aider is not implemented.

Two settings control the default pair. `AGENT_HARNESS` selects the harness and
defaults to `opencode`. `CODING_MODEL` takes any `provider/model` the selected
harness supports. The deploy defaults in `README.md` include `GATEWAY_ID` as
`default`, `ORCHESTRATOR_MODEL` as `@cf/meta/llama-3.1-8b-instruct`, and
`CODING_MODEL` as `google/gemini-3.5-flash-lite`. Devin has its own
`DEVIN_MODEL` deploy default, with `devin/swe-2` as the default model.

`AGENT_HARNESS` is only the deployment default. The dashboard's New Coding Task
form picks the harness per run, and per-run selection overrides the deploy
default. A run is therefore a choice, not a property of the deployment.

## The rules for a valid pairing

The model namespace has to match the harness. `claude-code.mdx` lays out the
supported sets: OpenCode covers `google/*`, `anthropic/*`, `openai/*`, and xAI
models such as `xai/grok-4`; Claude Code takes `anthropic/*`, for example
`anthropic/claude-sonnet-4-6`; Codex takes `openai/*`, for example
`openai/gpt-5.3-codex`; Devin takes `devin/*`.

An unsupported pairing is refused while preparing the approval, before
execution, with a message naming what the harness does support. `VERIFICATION.md`
records where that refusal lands: on the approval card, never inside a container
the human already approved.

The same document warns about model id churn. Model ids retire, and
`gemini-2.0-flash` was shut down on 2026-06-01, which is why the default moved.
The checked-in model name is not a service guarantee. Verify availability in
your own account.

## The complication: the numbers are missing on purpose

Here is the part that is easy to misread. `README.md` says tokens dominate the
Cloudflare bill, roughly 20 to 40 times the compute cost, so provider choice is
the lever that matters. That sentence is a rough claim in a README, not a
measurement.

`costs.md` takes the number back out. It states that no prices or free-use
guarantees are given, and that no measured price or end-to-end cloud usage is
available in the dated verification record. The earlier cost-ratio language is
intentionally omitted there because it is not evidenced.

Read the two documents together and the position is clear. Provider choice is
the variable most likely to matter for your bill. This repository does not
measure how much, and will not estimate it for you.

## What the harness tests do and do not prove

`claude-code.mdx` covers selection, argv, config, and env construction, provider
allowlists, and event parsing. It then draws the line in the same paragraph:
these tests do not prove the CLIs can complete a task end to end.

The verification record is specific. One local `wrangler dev` end-to-end
exercise with OpenCode on 2026-09-19 returned a 401, so inference and
successful completion were not verified. No live cloud end-to-end run has been
performed. Claude Code, Codex, and Devin have unit coverage only.

So OpenCode is the only harness that has been exercised against a live CLI, and
that exercise did not reach a successful model call. The other three parsers are
asserted from their documented stream formats. `README.md` treats harness CLI
bumps as breaking for that reason, because a stream-format change makes a run
look like it hangs rather than fail.

## The credential constraint on your choice

Your harness choice constrains your credential options. Claude Code and Codex
are API-key harnesses only. Subscription credentials are deliberately not
proxied, because Anthropic's terms forbid a third party routing requests through
Free, Pro, or Max plan credentials on a user's behalf.

One more limit to know: `registry.npmjs.org` is not on the egress allowlist, so
`npm install` inside a run is refused. Plan for a repository that is already
installable, or install before you queue the run.

## The resolution: publish limits, not verdicts

The costs document answers the question with a limits table instead of a
leaderboard. Maximum concurrent coding runs and configured container instances
is 5. The OpenCode timeout is 15 minutes. The Git command timeout is 5 minutes.
The collected diff is 120,000 characters, the transcript diff display is
20,000, the stderr tail is 8,000, captured files cap at 50, per-file captured
contents at 100,000 characters, and total captured contents at 500,000.

Those are application settings, not Cloudflare plan quotas and not guaranteed
in-memory read bounds. Capture truncation can make a publication incomplete.

The honest procedure is therefore: pick the harness your task shape fits, pick a
model its namespace allows, let the config check refuse anything invalid before
you approve, and read your own account's pricing pages. The repository gives you
the shape of the choice. It does not give you a winner.

Read next: [what a failed run looks like](/blog/what-a-failed-run-looks-like/).
