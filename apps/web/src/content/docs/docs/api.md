---
title: API reference
description: Current routes, responses, and SDK approval transport.
---

All paths are relative to the Worker origin. The shared orchestrator name is default. These routes do not implement their own user authorization; protect the installation before exposure.

## Email API

`GET /api/email/openapi.json` serves the machine-readable OpenAPI 3.1 contract (`apps/backend/src/email-openapi.json`) for this installation's mailbox, email, thread, draft, and attachment routes. It describes **Shiba's own API**, not Goshen Email's `/v1` API. Production requests need a valid Cloudflare Access session/JWT; an `Authorization: Bearer` MCP token does not authenticate these dashboard routes. Local `wrangler dev` can run without Access.

The end-to-end flow is:

1. Register an address with `POST /api/mailboxes` (`{"address":"agent@example.com"}`). Configure Cloudflare Email Routing for that address to deliver to this Worker; registration alone cannot change DNS or routing.
2. Incoming mail is accepted only for a registered address, stored in its Mailbox Durable Object, and attachment bytes go to R2. `GET /api/emails?mailbox=agent%40example.com` lists it; `GET /api/emails/{emailId}` returns the body and an attachment manifest. `GET /api/emails/{emailId}/attachments/{partId}` streams a manifest-backed attachment as a forced download.
3. Create an outbound draft with `POST /api/drafts`, then call `POST /api/drafts/{draftId}/send`. This **only queues a frozen `email_send` approval**. The draft stays queued until a human approves it in the Approvals tab or configured Slack channel. Only then does the Worker call its `SEND_EMAIL` binding; a rejected approval releases the draft for editing.

For agents, the existing `/mcp` gateway exposes scoped email tools. Its `email:send` tools also queue approval, never bypass it. Mail content and attachments are untrusted input; do not treat them as agent instructions. The OpenAPI route does not create a Goshen-compatible bearer-token API or remove the need to provision Cloudflare Email Routing, Email Sending, R2, and Access.

## Run registry

| Method | Path | Response |
| --- | --- | --- |
| GET | /api/runs | JSON object containing runs array |
| GET | /api/runs/:id | JSON object containing run; unknown ID returns 404 |
| DELETE | /api/runs/:id | Cancellation request; returns run, or 404 if unknown |
| DELETE | /api/runs | Clears registry; returns ok: true |

URL-encode the entire run ID, which can include colons. Records contain runId, sandboxId, repoUrl, task, baseBranch, publishPullRequest, status, createdAt, updatedAt, and optional summary/error. Timestamps are Unix milliseconds. Statuses: pending, running, completed, error, aborted, cancelled. Diffs/files belong to the transcript, not independent registry fields.

Cancellation updates state before best-effort destruction. Registry clearing does not stop work or erase child storage. Other methods return 405.

## Submit and approve

`POST /api/runs` queues an approval-gated run on the shared orchestrator; it does not start execution before approval. The dashboard also uses the `coding-orchestrator` agent SDK routes under `/agents/`.

The delegate_coding_task tool accepts:

~~~json
{
  "repoUrl": "https://github.com/owner/repository",
  "task": "Describe a bounded coding task",
  "baseBranch": "main",
  "publishPullRequest": false,
  "harness": "opencode",
  "codingModel": "google/gemini-3.5-flash-lite"
}
~~~

The agent tool sets `needsApproval: true`; approval decisions use `addToolApprovalResponse({ id, approved })` and delegated events use `useAgentToolEvents`. On the HTTP queue route, the approval is resolved through the approval endpoints/Slack interaction. Harness/model values are optional and validated before the run is approved. Harness unit tests cover construction and parsing, not successful CLI execution. The dated verification records a local OpenCode run only, which ended at a provider 401; no cloud end-to-end run is recorded.

## Provider traffic

There is no public `/api/provider` route. The coding model is called from inside the sandbox; Sandbox egress intercepts the provider host and swaps in the AI Gateway credential. Keep keys in the gateway, never in the container.

## GitHub webhook

POST /api/github/webhook requires GITHUB_WEBHOOK_SECRET and valid x-hub-signature-256. Missing configuration returns 503, invalid signatures 401, and invalid JSON 400. Valid payloads return ok, event name, and optional action. This handler acknowledges events only; it does not create coding tasks.

Source: apps/backend/src/index.ts and apps/backend/src/agents/orchestrator.ts.
