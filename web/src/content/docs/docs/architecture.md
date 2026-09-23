---
title: Architecture
description: Components, data flow, and unfinished integration boundaries.
---

<div class="arch-container">
  <div class="arch-header">
<div class="arch-header-title">
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
  <span>System Execution Architecture</span>
</div>
<div class="arch-badge-live">
  <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
  <span>Single-Tenant Cloudflare Perimeter</span>
</div>
  </div>

  <div class="arch-pipeline">
<!-- STAGE 1: ENTRY SURFACES -->
<div class="arch-stage">
  <div class="arch-stage-meta">
    <span class="arch-stage-tag">Stage 01</span>
    <span class="arch-stage-title">Entry Surfaces</span>
  </div>
  <div class="arch-stage-cards">
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Web Dashboard</span>
        <span class="arch-card-pill pill-active">/app/</span>
      </div>
      <p class="arch-card-desc">React 19 single-page app with task launcher, live diff review, and run inspector.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Slack ChatOps</span>
        <span class="arch-card-pill">@AI Coworker</span>
      </div>
      <p class="arch-card-desc">Interactive Block Kit approval cards and thread execution updates.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">GitHub Webhook</span>
        <span class="arch-card-pill">HMAC SHA-256</span>
      </div>
      <p class="arch-card-desc">Signature-verified push and issue acknowledgment endpoint.</p>
    </div>
  </div>
</div>

<!-- CONNECTOR 1 -->
<div class="arch-connector">
  <div class="arch-connector-line"></div>
  <div class="arch-connector-label">
    <span>↓</span>
    <span>Transport: Agent SDK RPC &amp; WebSockets</span>
  </div>
</div>

<!-- STAGE 2: EDGE ORCHESTRATOR & APPROVAL GATE -->
<div class="arch-stage">
  <div class="arch-stage-meta">
    <span class="arch-stage-tag">Stage 02</span>
    <span class="arch-stage-title">Edge Orchestrator</span>
  </div>
  <div class="arch-stage-cards">
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">CodingOrchestrator DO</span>
        <span class="arch-card-pill pill-active">Think + Durable Object</span>
      </div>
      <p class="arch-card-desc">Analyzes issue context, synthesizes multi-step delegation plan using Workers AI.</p>
    </div>
    <div class="arch-card" style="border-color: rgba(239, 68, 68, 0.4); background: rgba(239, 68, 68, 0.05);">
      <div class="arch-card-header">
        <span class="arch-card-name">Human Approval Gate</span>
        <span class="arch-card-pill pill-gate">needsApproval: true</span>
      </div>
      <p class="arch-card-desc">Synchronous human sign-off required. No container boots and no code runs without approval.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Retained Run Registry</span>
        <span class="arch-card-pill">/api/runs</span>
      </div>
      <p class="arch-card-desc">Persistent run state, task parameters, duration tracking, and status timestamps.</p>
    </div>
  </div>
</div>

<!-- CONNECTOR 2 -->
<div class="arch-connector">
  <div class="arch-connector-line"></div>
  <div class="arch-connector-label">
    <span>↓</span>
    <span>Approved Delegation: Spin Up Ephemeral Container</span>
  </div>
</div>

<!-- STAGE 3: ISOLATED SANDBOX RUNTIME -->
<div class="arch-stage">
  <div class="arch-stage-meta">
    <span class="arch-stage-tag">Stage 03</span>
    <span class="arch-stage-title">Isolated Sandbox</span>
  </div>
  <div class="arch-stage-cards">
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">OpenCodeAgent</span>
        <span class="arch-card-pill pill-active">AIChatAgent DO</span>
      </div>
      <p class="arch-card-desc">Structured task envelope managing lifecycle phases: Clone → Configure → Code → Collect.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Cloudflare Sandbox</span>
        <span class="arch-card-pill">gVisor MicroVM</span>
      </div>
      <p class="arch-card-desc">Ephemeral container (standard-1 to standard-4). Full Linux isolation with Git and Node.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Multi-Harness Runtime</span>
        <span class="arch-card-pill">OpenCode / Claude / Codex</span>
      </div>
      <p class="arch-card-desc">Executes code changes, writes regression tests, and validates with test runner.</p>
    </div>
  </div>
</div>

<!-- CONNECTOR 3 -->
<div class="arch-connector">
  <div class="arch-connector-line"></div>
  <div class="arch-connector-label">
    <span>↓</span>
    <span>Egress Proxy: Real Provider Keys Swapped at Boundary</span>
  </div>
</div>

<!-- STAGE 4: EGRESS, AI GATEWAY & OUTPUT -->
<div class="arch-stage">
  <div class="arch-stage-meta">
    <span class="arch-stage-tag">Stage 04</span>
    <span class="arch-stage-title">Egress &amp; Output</span>
  </div>
  <div class="arch-stage-cards">
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Cloudflare AI Gateway</span>
        <span class="arch-card-pill pill-active">BYOK Credentials</span>
      </div>
      <p class="arch-card-desc">Container uses dummy API key; egress gateway injects stored secret securely.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">Diff Collector</span>
        <span class="arch-card-pill">Git Intent-to-Add</span>
      </div>
      <p class="arch-card-desc">Captures unified diffs and changed files; packages clean commit envelope.</p>
    </div>
    <div class="arch-card">
      <div class="arch-card-header">
        <span class="arch-card-name">GitHub Pull Request</span>
        <span class="arch-card-pill">REST Publication</span>
      </div>
      <p class="arch-card-desc">Opens ready-to-merge PR with summary and links results back to Slack thread.</p>
    </div>
  </div>
</div>
  </div>
</div>

The parent uses Workers AI for planning. Real model-provider and GitHub credentials are not supplied to the container by this implementation. Provider traffic is intercepted at Sandbox egress; there is no public `/api/provider/google` route. The callback's authentication remains incomplete; the diagram is not a validated production security boundary.

## Source map

| Path | Responsibility |
| --- | --- |
| backend/src/index.ts | Assets, SDK routes, run API, provider forwarding, webhook |
| backend/src/agents/orchestrator.ts | Planning, approval, delegation, retained registry |
| backend/src/agents/opencode-agent.ts | Sandbox SDK operations, progress and publishing |
| src/runtime.ts | Clone, OpenCode execution, bounded file/diff collection |
| src/provider-gateway.ts | Server-side provider forwarding |
| backend/src/github.ts | GitHub REST publication |
| src/runs.ts and src/transcript.ts | State and transcript helpers |
| frontend/src/main.tsx and frontend/src/app.tsx | Mounted dashboard |
| docs/ and scripts/ | Static documentation and build checks |

No D1, KV, Queues, R2, Postgres, Redis, or separate frontend service is required. State resides in Agents/Sandbox Durable Objects.

The runtime emits clone/configure/code/collect phases but awaits OpenCode execution; it does not stream every JSON event. The registry stores metadata and summary/error, not separate diff/file fields.

The specification requires Sandbox HTTPS interception, private Git transport credentials, and retained-registry gating of child routes. The present Worker proxy and direct SDK routing do not provide those guarantees. See [Readiness](/docs/readiness/).

## Alternative runtimes

The computer adapter is a guarded refusal, not an implemented runtime. The intended fit of @cloudflare/computer includes persistent SQLite-backed VFS, typed Git operations, agent tools, and Worker-shell/container backends. It is not installed here. Verify current APIs and preview status in the [package documentation](https://www.npmjs.com/package/@cloudflare/computer) before implementing it. The code retains the preview-only warning and defaults to Sandbox.

celld is not a deployment target: Workers-compatible execution alone does not provide the managed Sandbox/Containers bindings this repository uses.

Official sources: [Agents](https://developers.cloudflare.com/agents/), [Sandbox](https://developers.cloudflare.com/sandbox/), [Containers](https://developers.cloudflare.com/containers/), [AI Gateway](https://developers.cloudflare.com/ai-gateway/).
