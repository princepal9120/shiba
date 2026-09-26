---
title: Automations
description: Configure approval-gated scheduled, webhook, Slack, GitHub, and manual automation triggers.
---

Automations evaluate configured triggers and queue approval-gated runs. They do not establish that an unattended task is cloud-live; the dated [`VERIFICATION.md`](/docs/verification/) reports no cloud end-to-end run.

---

## Trigger kinds

Automations support up to 20 triggers evaluated together (`OR` semantics). When any trigger condition is met, AI Coworker initiates an approval-gated delegation run.

| Kind | Trigger Source | Frequency / Floor |
| :--- | :--- | :--- |
| **`schedule`** | Five-field cron expressions evaluated via Cloudflare Triggers | Minimum 5-minute floor; missed ticks coalesce |
| **`github`** | Webhook events: PR opened, commits pushed, issues labeled, reviews | Real-time via `/api/github/webhook` |
| **`slack`** | Mentions, channel alerts, or bot notifications | Real-time via `/api/slack/events` |
| **`webhook`** | Dedicated HTTP endpoint with per-automation authentication token | `POST /api/automations/{id}/trigger` |
| **`manual`** | Triggered immediately from the Dashboard or CLI | On-demand execution |

---

## Implementation and verification status

The trigger engine (`apps/backend/src/automations.ts`), runner (`apps/backend/src/automation-runner.ts`), and `Automations` Durable Object are implemented and covered by unit tests. The Worker has a scheduled handler and configured five-minute cron; this configuration is not evidence of a live Cloudflare cron firing. Tests exercise trigger matching, gates, authorization, and queue behavior. Do not describe the automation path as cloud-live: the dated verification records no cloud end-to-end run. Create records with `POST /api/automations`.

The per-automation webhook secret is returned once on create and never again, and must be sent as the `x-automation-secret` header. It is never accepted as a `?secret=` query parameter — query strings land in proxy and access logs, which is exactly where a credential must not appear.

---

## Configuring an automation

You can declare automations in your dashboard or programmatically via the API:

```json
{
  "id": "nightly-dep-audit",
  "prompt": "Audit dependencies for known vulnerabilities, update patch versions, and run vitest",
  "repoUrl": "https://github.com/org/web-app",
  "enabled": true,
  "triggers": [
    {
      "kind": "schedule",
      "cron": "0 2 * * *"
    },
    {
      "kind": "github",
      "events": ["pull_request:closed"]
    }
  ]
}
```

---

## Missions

A mission is a standing goal rather than a one-off task: an automation created with `mission: true`, shown on the dashboard's **Missions** surface. Each cadence tick evaluates the `run_when` gate — "does this goal still have unfinished work?" — and queues a run only while it does. Every check-in stays approval-gated; a mission schedules work, it does not authorize it.

```json
{
  "prompt": "Standing goal: keep dependency vulnerabilities at zero on main",
  "repoUrl": "https://github.com/org/web-app",
  "mission": true,
  "enabled": true,
  "triggers": [
    { "kind": "schedule", "cron": "0 3 * * *", "runWhen": "the standing goal still has unfinished work or new relevant changes" },
    { "kind": "manual" }
  ]
}
```

This is a recurring gated check-in, not a checkpointed multi-day process: there is no resumable agent memory between runs. Each check-in is a normal run with its own approval, diff, and outcome.

---

## The `run_when` gate

Exact filters cannot express *"only when it's actually a bug report"*. Any trigger may carry a `run_when` sentence, checked by the cheap Workers AI orchestrator model before the run starts: a single call, no AI Gateway round trip, and no token bill against your provider key.

```json
{ "kind": "github", "events": ["issues:opened"], "runWhen": "the issue is a bug report, not a feature request" }
```

The gate **fails closed**. A model error, an empty answer, or anything not clearly affirmative means no run, and the reason is recorded on the automation rather than dropped.

---

## Safety and rate limiting

An automation is an approval gate with nobody standing at it. Three controls apply together, plus two kill switches:

- **Approval by default.** Every automated run posts an approval card and starts no container until a human approves it. An automation schedules work; it does not authorize it.
- **Unattended mode is opt-in and narrow.** Set `unattended: true` *and* list the repo in `unattendedRepos`. It is refused unless opening a pull request is the run's only mutation: a PR is reviewable and revertible, nothing else is.
- **Daily run budget.** `dailyRunLimit` (default 20) per automation per UTC day. A cron misconfiguration or a webhook loop otherwise burns tokens until somebody notices, and provider inference and platform compute may both incur charges; no ratio or per-run price is claimed here. Run N+1 is refused with the reason.
- **Schedule floor.** A strict minimum of 5 minutes between firings (`SCHEDULE_FLOOR_MINUTES = 5`); missed ticks coalesce into one run, never a backlog.
- **Concurrency.** Automations share the global limiter (`MAX_CONCURRENT_RUNS = 5`, matching `max_instances`). The global run limit is five, matching configured `max_instances`; requests over the limit are refused by the run queue rather than guaranteed to wait. Actual billing depends on account usage and pricing.
- **Kill switches.** `enabled: false` per automation, and the `AUTOMATIONS_ENABLED` var globally.
