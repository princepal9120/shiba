import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({
    fetch: async () => new Response("{}", { status: 404 }),
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("@cloudflare/think", () => ({
  Think: class {
    onStart() {}
    getTools() {
      return {};
    }
    onRequest() {
      return new Response(null, { status: 404 });
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve() {
      return { fetch: async () => Response.json({ mcp: "served" }) };
    }
  },
}));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";
import { TOKEN_PREFIX } from "../src/agent-tokens.js";
import { SessionsSidebar } from "../../frontend/src/components/SessionsSidebar";
import { WorkspacePanel, type WorkspacePanelProps } from "../../frontend/src/components/WorkspacePanel";

/** In-memory KV standing in for AGENT_TOKENS — stores JSON strings like the real binding. */
class FakeKV {
  readonly map = new Map<string, string>();
  constructor(records: Record<string, unknown> = {}) {
    for (const [key, record] of Object.entries(records)) {
      this.map.set(key, JSON.stringify(record));
    }
  }
  async get(key: string, opts?: { type?: string }) {
    const value = this.map.get(key);
    return value === undefined ? null : opts?.type === "json" ? JSON.parse(value) : value;
  }
  async put(key: string, value: string) {
    this.map.set(key, value);
  }
  async list(opts?: { prefix?: string; cursor?: string; limit?: number }) {
    const names = [...this.map.keys()]
      .filter((name) => name.startsWith(opts?.prefix ?? ""))
      .sort();
    return { keys: names.map((name) => ({ name })), list_complete: true, cursor: "", cacheStatus: null };
  }
}

const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

function envWithTokens(records: Record<string, unknown>): Env {
  return { AGENT_TOKENS: new FakeKV(records) } as unknown as Env;
}

describe("GET /api/agents", () => {
  it("returns the CLI catalog plus registered token principals with connection state", async () => {
    const env = envWithTokens({
      [`${TOKEN_PREFIX}a`]: {
        principal: "ci-bot",
        scopes: ["email:read", "memory:write"],
        created: 2000,
        revoked: false,
      },
      [`${TOKEN_PREFIX}b`]: {
        principal: "ci-bot",
        scopes: ["email:read"],
        created: 1000,
        revoked: true,
      },
      [`${TOKEN_PREFIX}c`]: {
        principal: "webhook",
        scopes: ["sandbox:exec"],
        created: 1500,
        revoked: true,
      },
    });
    const response = await worker.fetch(new Request("https://worker/api/agents"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      agents: Array<{ id: string }>;
      principals: Array<{ principal: string; scopes: string[]; created: number; live: boolean }>;
    };
    // The harness catalog is untouched — AgentsView consumes it unchanged.
    expect(body.agents.map((a) => a.id)).toContain("opencode");
    expect(body.principals).toEqual([
      { principal: "ci-bot", scopes: ["email:read", "memory:write"], created: 1000, live: true },
      { principal: "webhook", scopes: ["sandbox:exec"], created: 1500, live: false },
    ]);
  });

  it("degrades to an empty principal list when the token store is missing", async () => {
    const env = {} as Env;
    const response = await worker.fetch(new Request("https://worker/api/agents"), env, ctx);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { agents: unknown[]; principals: unknown[] };
    expect(Array.isArray(body.agents)).toBe(true);
    expect(body.principals).toEqual([]);
  });
});

const noop = () => {};

describe("SessionsSidebar agents group", () => {
  const sidebarProps = {
    selectedId: "live",
    onSelect: noop,
    onNewTask: noop,
    connectionLabel: "Connected",
    connectionTone: "ok" as const,
    setupDone: 6,
    setupTotal: 6,
    onOpenSetup: noop,
  };

  it("renders an Agents group below Active with principal, live dot, and scope summary", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionsSidebar, {
        ...sidebarProps,
        sessions: [
          {
            id: "live",
            title: "Current session",
            repoName: "owner/repo",
            status: "live",
            updatedAt: Date.now(),
            live: true,
          },
        ],
        agents: [
          { principal: "ci-bot", scopes: ["email:read", "memory:write"], created: 1, live: true },
          { principal: "old-bot", scopes: ["sandbox:exec"], created: 2, live: false },
        ],
      }),
    );
    expect(markup).toContain('aria-label="Agents"');
    expect(markup).toContain("ci-bot");
    expect(markup).toContain("old-bot");
    expect(markup).toContain("email:read, memory:write");
    // Agents sit between Active and Recent.
    expect(markup.indexOf('aria-label="Active sessions"')).toBeLessThan(
      markup.indexOf('aria-label="Agents"'),
    );
  });

  it("omits the Agents group when no principals are registered", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionsSidebar, {
        ...sidebarProps,
        sessions: [],
        agents: [],
        selectedId: null,
        setupDone: null,
      }),
    );
    expect(markup).not.toContain('aria-label="Agents"');
  });

  it("still renders the Agents group when the session list is empty", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionsSidebar, {
        ...sidebarProps,
        sessions: [],
        agents: [
          { principal: "ci-bot", scopes: ["email:read"], created: 1, live: true },
        ],
        selectedId: null,
      }),
    );
    expect(markup).toContain("No sessions yet");
    expect(markup).toContain('aria-label="Agents"');
    expect(markup).toContain("ci-bot");
  });
});

describe("WorkspacePanel unified Approvals tab", () => {
  const baseProps: WorkspacePanelProps = {
    toolRuns: [],
    retainedRuns: [],
    vmRuns: [],
    pendingApprovals: [],
    decisions: {},
    onDecideApproval: noop,
    storedApprovals: [],
    storedDecisions: {},
    decidedStoredApprovals: [],
    storedApprovalsError: null,
    onDecideStoredApproval: noop,
    onRefreshRuns: noop,
    onInspectVM: noop,
    selectedRunId: null,
    onSelectRun: noop,
    collapsed: false,
    onToggleCollapsed: noop,
    tab: "approvals",
  };

  it("renders one pending list holding chat and stored approvals with agent names", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkspacePanel, {
        ...baseProps,
        pendingApprovals: [
          {
            messageId: "m1",
            toolCallId: "tc1",
            approvalId: "apv-chat",
            tool: "delegate_coding_task",
            input: { task: "fix the build" },
          },
        ],
        storedApprovals: [
          {
            threadKey: "default",
            approvalId: "apv-email",
            repoUrl: "agent-a@shiba.dev",
            task: "Send email to alice@example.com: deploy?",
            status: "pending",
            createdAt: Date.now() - 60_000,
            kind: "email_send",
            payload: {
              mailbox: "agent-a@shiba.dev",
              to_addr: "alice@example.com",
              subject: "deploy?",
              body_text: "ok?",
            },
          },
          {
            threadKey: "slack:C123",
            approvalId: "apv-run",
            repoUrl: "https://github.com/o/r",
            task: "Fix lint",
            status: "pending",
            createdAt: Date.now() - 30_000,
            kind: "run",
            baseBranch: "main",
            publishPullRequest: true,
          },
        ],
        orchestratorName: "default",
      }),
    );
    // One merged group — not two separate sections.
    expect(markup).toContain('aria-label="Pending approvals"');
    expect(markup).not.toContain("Queued approvals");
    // Chat approval card: tool, args, the orchestrator name, and its actions.
    expect(markup).toContain("delegate_coding_task");
    expect(markup).toContain("fix the build");
    expect(markup).toContain("via default");
    // Stored cards: kind labels + agent line + frozen args.
    expect(markup).toContain("Email send");
    expect(markup).toContain("via agent-a@shiba.dev");
    expect(markup).toContain("via slack:C123");
    expect(markup).toContain("publishPullRequest");
    expect(markup.match(/Approve/g)?.length).toBeGreaterThanOrEqual(3);
    expect(markup).toContain("Reject");
  });

  it("falls back to the repoUrl mailbox when an email payload lacks mailbox", () => {
    const markup = renderToStaticMarkup(
      React.createElement(WorkspacePanel, {
        ...baseProps,
        storedApprovals: [
          {
            threadKey: "default",
            approvalId: "apv-del",
            repoUrl: "agent-b@shiba.dev",
            task: "Delete email eml-9",
            status: "pending",
            createdAt: Date.now(),
            kind: "email_delete",
            payload: { email_id: "eml-9" },
          },
        ],
      }),
    );
    expect(markup).toContain("Email delete");
    expect(markup).toContain("via agent-b@shiba.dev");
  });
});
