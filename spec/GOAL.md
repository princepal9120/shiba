# AI Coworker Cloudflare Native Goal

## Outcome

Replace the current Python, Docker Compose, Postgres, Redis, Celery, and separate Next.js prototype with one open source Cloudflare Workers application that users deploy into their own Cloudflare account.

Use Cloudflare Agents SDK for durable orchestration and human approval. Use Cloudflare Sandbox SDK and Containers for isolated repository work. Use OpenCode inside each sandbox as the coding harness.

Evaluate `@cloudflare/computer` as an optional workspace runtime. It must not replace the default Sandbox path because Cloudflare labels Computer preview-only and not production-ready. Keep the runtime boundary explicit so a self-hosting user can opt into Computer later without changing orchestration, approval, or UI contracts.

Do not deploy, push, or alter any external system while implementing this repository. Local code and tests only.

## Product contract

A user must be able to:

1. Clone this repository.
2. Run `npm install`.
3. Configure their account-owned AI Gateway and optional GitHub token.
4. Run `npm run deploy`.
5. Open one dashboard served by the Worker.
6. Enter a GitHub repository URL and coding task.
7. Review an approval card before any sandbox execution starts.
8. Approve or reject the task.
9. Watch a Cloudflare Agent delegate the task to an isolated Cloudflare Sandbox container.
10. See OpenCode progress, changed files, and a unified diff.
11. Optionally request a branch and pull request when a GitHub token is configured.
12. Optionally configure a Slack app: mention @shiba-ai-coworker in any thread to start a task. The bot posts an approval card in-thread before any container starts; only SLACK_APPROVERS can approve from Slack.
13. Use the /shiba-ai-coworker slash command to start a task from Slack without an existing thread.
14. Create automations with schedule (cron), GitHub event, Slack, webhook, or manual triggers. Each automation has an optional run_when plain-language condition (evaluated by TypeSafe Noul when TYPESAFE_API_KEY is set, else Workers AI). Automated runs require approval by default; opt-in unattended mode is available only for pull-request-only mutations on an explicit repo allowlist.

The dashboard is one inbound surface of two. Slack (`@shiba-ai-coworker` mentions and `/shiba-ai-coworker`) is a supported entry point: thread prose is turned into structured `delegate_coding_task` by the orchestrator LLM. Prose never crosses the child boundary (`parseAgentToolInput`). Slack approvals require `SLACK_APPROVERS`; an empty list means nobody can approve from Slack.


## Required architecture

Keep the smallest working architecture. Do not add D1, KV, Queues, R2, Workflows, Hono, or a monorepo unless a concrete requirement needs one.

Use:

- TypeScript
- Vite and React for the dashboard
- Cloudflare Workers Static Assets for frontend delivery
- `agents` and `@cloudflare/think` for the parent orchestrator
- `@cloudflare/ai-chat` for the sandbox coding sub-agent
- `@cloudflare/sandbox` and Cloudflare Containers for the default repository runtime
- A small runtime adapter seam exercised by tests. The default adapter wraps Sandbox SDK. An optional experimental adapter may wrap `@cloudflare/computer` only if it is complete, deployable, and does not weaken the default path
- Workers AI binding for the parent planning model
- AI Gateway for the OpenCode model path
- Durable Objects supplied by Agents SDK and Sandbox SDK for state
- Vitest for focused tests

The Worker entry must export:

- `CodingOrchestrator`, extending `Think<Env>`
- `OpenCodeAgent`, extending `AIChatAgent<Env>`
- `Sandbox`, extending the Sandbox SDK class
- `ContainerProxy` from `@cloudflare/sandbox`

Route Agent HTTP and WebSocket requests with `routeAgentRequest`.

## Agent behavior

`CodingOrchestrator` is a planning and delegation agent. It never edits repositories itself.

Its `delegate_coding_task` tool must accept structured input:

- `repoUrl`
- `task`
- `baseBranch`, default `main`
- `publishPullRequest`, default `false`

The delegation tool must use AI SDK `needsApproval: true`. No sandbox starts before the human approves the exact tool input.

Each delegated run gets its own deterministic, DNS-safe sandbox ID and isolated container. Limit concurrent coding agents to three.

`OpenCodeAgent` must format and parse structured agent-tool input explicitly. Do not scrape arbitrary prose to discover the repository URL.

The sandbox must:

1. Validate that the repository is an HTTPS GitHub repository URL.
2. Clone the requested base branch into a per-run working directory.
3. Run OpenCode headlessly with JSON output.
4. Stream useful text and tool progress to the parent UI.
5. Capture changed files and a unified diff, including new files.
6. Report failures honestly, including process exit code and a bounded stderr tail.
7. Never pass real model-provider credentials into the container process.

Install `opencode-ai` in the container image. Pin the Sandbox npm package and base image to compatible published versions.

Default the coding model to a configurable Gemini Flash model. Use OpenCode's Google provider with a dummy key. Intercept the container's Google AI Studio HTTPS egress in the Sandbox Durable Object and forward the provider-native request through the account owner's Cloudflare AI Gateway binding. The real provider key or Unified Billing credential must stay in AI Gateway, outside the container.

Use plain Worker vars for non-secret settings:

- `GATEWAY_ID`, default `default`
- `ORCHESTRATOR_MODEL`
- `CODING_MODEL`

Use a Wrangler secret only for optional GitHub access:

- `GITHUB_TOKEN`

Public repositories and diff-only tasks must work without `GITHUB_TOKEN`.

If `publishPullRequest` is true and no token exists, fail before coding with a clear configuration error. If configured, keep the token out of the container. Inject GitHub Git transport authorization through Sandbox HTTPS interception, and call the GitHub pull request API from Worker code. Never put the token in a clone URL, command, process environment, log, or UI response.

## Dashboard

Replace the marketing-only page with a functional dashboard.

Required UI:

- Product title and short self-hosted Cloudflare explanation
- Repository URL field
- Base branch field
- Task input
- Optional publish pull request control
- Connection state
- Conversation history
- Approval and rejection buttons using `addToolApprovalResponse`
- Live delegated-run progress using `useAgentToolEvents`
- OpenCode text, tool activity, changed files, and diff output
- Clear history action that also clears retained delegated runs
- Responsive desktop and mobile layout
- Accessible labels and keyboard submission
- No fake metrics, testimonials, or fabricated activity

Use a restrained developer-tool visual style. Prefer native CSS and existing dependencies over a large component library.

## Security

- Validate all external URLs.
- Reject non-HTTPS, non-GitHub repository URLs.
- Shell-quote every dynamic command argument with a tested helper.
- Do not concatenate untrusted text into shell commands.
- Bound streamed log and diff sizes.
- Redact secrets and authorization headers.
- Gate child drill-in routes with the parent's retained run registry.
- Document Cloudflare Access as required before exposing a deployment to a team or the public internet.
- Do not claim full multi-tenant isolation. Each installation is single-tenant and account-owned.

## Repository cleanup

Delete obsolete Python backend, Docker Compose, Postgres, Redis, Celery, legacy setup wizard, and old Next.js dashboard files. Keep useful product language only where accurate.

Add:

- Root `package.json` and lockfile
- `backend/wrangler.jsonc`
- Sandbox `Dockerfile`
- Vite and TypeScript config
- Worker and dashboard source
- Focused unit tests
- `.dev.vars.example` without secrets
- Complete README
- MIT license if none exists

## README contract

Document:

- What the product does
- Architecture diagram
- Account ownership model
- Cloudflare prerequisites and current Sandbox or Containers plan limitations
- Exact local development commands
- Exact deployment commands
- AI Gateway setup with Unified Billing or stored BYOK key
- Optional GitHub secret setup
- Cloudflare Access protection
- Troubleshooting
- Cost surfaces without invented prices
- `@cloudflare/computer` fit: persistent SQLite-backed VFS, typed git, agent tools, worker-shell and container backends, plus its current preview-only warning and why Sandbox remains the default
- Why celld is not a current deployment target: it can run Workers-style code, but it does not provide Cloudflare's managed Sandbox and Container product required by this implementation
- Source links to official Cloudflare Agents, Sandbox, Computer, Containers, AI Gateway, and Access documentation

## Verification

Run all applicable checks and fix failures:

```bash
npm install
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

If the final dry run cannot complete because no compatible local container engine is running, record that exact limitation. The TypeScript build and unit tests must still pass.

No generated placeholder implementation. No fake successful output. No external deployment. No push.