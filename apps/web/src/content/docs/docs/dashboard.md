---
title: Dashboard
description: Compose, approve, observe, and interpret the current interface.
---

Enter an HTTPS GitHub URL, base branch, and bounded task. Start without publishing. The planning agent proposes delegate_coding_task; review the **exact tool input**, then approve or reject it. Approval is a workflow gate, not installation authentication.

## Progress and results

The SDK supplies connection state. Vite-only development has no Worker backend, so connection errors are expected there.

Clone/configure/code/collect phases stream, but the runtime awaits the OpenCode process before returning its output. Token-level OpenCode streaming is not implemented. Inspect the final transcript for changes, bounded diff, errors, and any PR URL. These are not independent fields in the retained run API.

The parent currently treats string child output as completed, including possible error text. **Read the transcript, not just a completed badge.** An empty diff is not evidence of successful edits.

## Missions and Quality Gates

The **Missions** tab presents standing goals — recurring automations (`mission: true`) whose `run_when` gate re-queues work only while the goal is unfinished. The **Gates** tab presents typed entry points for Code Review, QA (test generation), and Security Review; each builds a task prompt and queues it through the same `/api/runs` approval path. Both use the ordinary run/approval path; PR publication is an optional run setting and also requires configured GitHub credentials. These surfaces are implemented and covered by component/API tests; their presence does not demonstrate cloud-live execution.

## Cancel and clear

Cancellation updates the registry before best-effort sandbox destruction. A successful request does not prove the process stopped. Verify shutdown for sensitive work.

Clear history asks for confirmation and clears chat plus retained registry records. It does not erase all child Durable Object data or stop active containers. Cancel and verify active work before clearing. If only part of the clear succeeds, the UI reports partial success; refresh to recheck retained state.

Review every generated diff and truncation marker. Run the target repository's tests before adoption. See [GitHub](/docs/github/) for publication fidelity limits.

