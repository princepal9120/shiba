import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agent: {
    connectionError: null,
    identified: true,
  },
  chat: {
    messages: [] as Array<{ id: string; role: string; parts: unknown[] }>,
    error: null as Error | null,
    isStreaming: false,
    status: "ready",
    sendMessage: vi.fn(),
    clearHistory: vi.fn(),
    addToolApprovalResponse: vi.fn(),
  },
  runsById: {} as Record<string, unknown>,
}));

vi.mock("agents/react", () => ({
  useAgent: () => mocks.agent,
  useAgentToolEvents: () => ({ runsById: mocks.runsById }),
}));

vi.mock("@cloudflare/ai-chat/react", () => ({
  useAgentChat: () => mocks.chat,
  getToolApproval: (part: { approvalId?: string }) =>
    part.approvalId ? { id: part.approvalId } : undefined,
  getToolCallId: (part: { toolCallId?: string }) => part.toolCallId ?? "call",
  getToolInput: (part: { input?: unknown }) => part.input,
  getToolPartState: (part: { state?: string }) => part.state,
}));

vi.mock("ai", () => ({
  isToolUIPart: (part: { type?: unknown }) =>
    typeof part.type === "string" && part.type.startsWith("tool-"),
}));

import { App } from "../../frontend/src/app";
import { AnalyticsView } from "../../frontend/src/components/AnalyticsView";
import { AutomationsView } from "../../frontend/src/components/AutomationsView";
import { DashboardView } from "../../frontend/src/components/DashboardView";
import { DiffView } from "../../frontend/src/components/DiffView";
import { ApprovalsView } from "../../frontend/src/components/ApprovalsView";
import { OnboardingModal, ONBOARDING_STEPS } from "../../frontend/src/components/OnboardingModal";
import { TaskForm } from "../../web/src/components/TaskForm";
import { Tooltip } from "../../frontend/src/components/Tooltip";

afterEach(() => {
  mocks.chat.messages = [];
  mocks.chat.error = null;
  mocks.chat.isStreaming = false;
  mocks.chat.status = "ready";
  mocks.runsById = {};
  vi.clearAllMocks();
});

function renderApp() {
  return renderToStaticMarkup(React.createElement(App));
}

describe("dashboard rendering", () => {
  it("renders the dashboard overview and links to real capability surfaces", () => {
    const markup = renderToStaticMarkup(React.createElement(DashboardView, {
      runs: [],
      pendingApprovals: [],
      storedApprovals: [],
      agents: [],
      connectionLabel: "Connected",
      connectionTone: "ok",
      runsError: null,
      onNavigate: vi.fn(),
      onNewTask: vi.fn(),
      onInspectRun: vi.fn(),
    }));

    expect(markup).toContain("Your agent plane");
    expect(markup).toContain("Agents &amp; MCP");
    expect(markup).toContain("Mailbox");
    expect(markup).toContain("Memory");
    expect(markup).toContain("Sandbox");
    expect(markup).toContain("No runs yet.");
  });

  it("shows useful empty states when no task has started", () => {
    const markup = renderApp();

    expect(markup).toContain("No messages yet. Submit a task to start.");
    expect(markup).toContain("Setup Guide");
    expect(markup).toContain("Sessions");
    expect(markup).toContain("Fix Failing Tests");

  });

  it("renders a pending approval with its tool input and actions", () => {
    mocks.chat.messages = [
      {
        id: "message-1",
        role: "assistant",
        parts: [
          {
            type: "tool-runSandbox",
            state: "waiting-approval",
            approvalId: "approval-1",
            toolCallId: "call-1",
            input: { command: "npm test" },
          },
        ],
      },
    ];

    const markup = renderApp();

    expect(markup).toContain("waiting for your approval");
    expect(markup).toContain("Action Required");
    expect(markup).toContain("runSandbox");
    expect(markup).toContain("&quot;command&quot;: &quot;npm test&quot;");
    expect(markup).toContain("Approve");
    expect(markup).toContain("Reject");
  });

  it("renders chat errors and live run output without hiding the run state", () => {
    mocks.chat.error = new Error("stream failed");
    mocks.runsById = {
      "run-1": {
        runId: "run-1",
        status: "error",
        agentType: "coding-agent",
        parentToolCallId: "call-1",
        parts: [{ text: "sandbox failed" }],
        summary: "The sandbox exited early.",
        error: "exit code 1",
      },
    };

    const markup = renderApp();

    expect(markup).toContain("Chat error: stream failed");
    expect(markup).toContain("run-1");

  });

  it("renders task submission form", () => {
    const formMarkup = renderToStaticMarkup(React.createElement(TaskForm));

    expect(formMarkup).toContain('data-testid="task-submission-form"');
    expect(formMarkup).toContain('type="url"');
    expect(formMarkup).toContain("required");
    expect(formMarkup).toContain("<textarea");
    expect(formMarkup).toContain('type="checkbox"');
    expect(formMarkup).toContain('value="main"');

    const appMarkup = renderApp();

    expect(appMarkup).toContain('data-testid="task-composer"');
    expect(appMarkup).toContain("<textarea");
    expect(appMarkup).toContain('type="checkbox"');
  });

  it("renders diff output for completed runs in standalone DiffView", () => {
    const run = {
      runId: "run-diff-1",
      sandboxId: "sb-diff-1",
      repoUrl: "https://github.com/owner/repo",
      task: "Implement feature",
      baseBranch: "main",
      publishPullRequest: false,
      status: "completed",
      createdAt: Date.now() - 10000,
      updatedAt: Date.now(),
      agentType: "coding-agent",
      parentToolCallId: "call-1",
      parts: [{ text: "done" }],
      summary: "Done.",
      diff: "diff --git a/src/a.ts b/src/a.ts\n+added line\n-removed line",
    };

    const diffMarkup = renderToStaticMarkup(
      React.createElement(DiffView, {
        runs: [run],
        selectedRunId: "run-diff-1",
      })
    );

    expect(diffMarkup).toContain("run-diff-1");
    expect(diffMarkup).toContain("Completed");
    expect(diffMarkup).toContain("diff --git");
    expect(diffMarkup).toContain("added line");
    expect(diffMarkup).toContain("removed line");
    expect(diffMarkup).toContain("<pre");
    expect(diffMarkup).toContain("<code");
  });

  it("renders the top navigation bar without the retired Architecture view", () => {
    const markup = renderApp();
    expect(markup).toContain("Dashboard");
    expect(markup).toContain("Tasks");
    expect(markup).toContain("Runs");
    expect(markup).toContain("Diff");
    expect(markup).toContain("Approvals");
    expect(markup).toContain("Mailbox");
    expect(markup).toContain("Memory");
    expect(markup).toContain("Automations");
    expect(markup).toContain("Providers");
    expect(markup).toContain("Integrations");
    expect(markup).not.toContain("Architecture");
    // Deduped surfaces stay deep-link reachable but are out of the nav.
    expect(markup).not.toContain("Missions &amp; Standing Goals");
    expect(markup).not.toContain("Review, QA &amp; Security Gates");
    expect(markup).not.toContain("VM Inspector &amp; Terminals");
    expect(markup).not.toContain("Usage, Costs &amp; Run Metrics");
  });

  it("renders standalone DiffView and ApprovalsView with empty states and zero-trust framing", () => {
    const diffMarkup = renderToStaticMarkup(
      React.createElement(DiffView, {
        runs: [],
      })
    );
    expect(diffMarkup).toContain("Diff &amp; Patch Inspector");
    expect(diffMarkup).toContain("No Task Runs Found");

    const approvalsMarkup = renderToStaticMarkup(
      React.createElement(ApprovalsView, {
        pendingApprovals: [],
        decisions: {},
        onDecideApproval: vi.fn(),
        storedApprovals: [],
        storedDecisions: {},
        decidedStoredApprovals: [],
        storedApprovalsError: null,
        onDecideStoredApproval: vi.fn(),
      })
    );
    expect(approvalsMarkup).toContain("Approvals &amp; Decision Center");
    expect(approvalsMarkup).toContain("All Clear");
    expect(approvalsMarkup).toContain("Zero-Trust Boundary");
    expect(approvalsMarkup).toContain("Cryptographic Audit Log");
  });




  it("renders AnalyticsView with the run table", () => {
    const runs = [
      {
        runId: "run-reg-1",
        sandboxId: "sb-1",
        repoUrl: "https://github.com/owner/repo",
        task: "Fix bug",
        baseBranch: "main",
        publishPullRequest: true,
        generation: 0,
        status: "completed" as const,
        createdAt: Date.now() - 30000,
        updatedAt: Date.now(),
      },
    ];
    const markup = renderToStaticMarkup(React.createElement(AnalyticsView, {
      runs,
      sessionId: "default",
      sessionApiAvailable: false,
    }));
    expect(markup).toContain("Analytics");
    expect(markup).toContain("Fix bug");
    expect(markup).toContain("owner/repo");
  });

  it("renders AutomationsView with webhook endpoints", () => {
    const markup = renderToStaticMarkup(React.createElement(AutomationsView));
    expect(markup).toContain("Automations &amp; Inbound Triggers");
    expect(markup).toContain("/api/github/webhook");
    expect(markup).toContain("/api/slack/command");
  });

  it("renders OnboardingModal with steps from PLAN.md", () => {
    expect(ONBOARDING_STEPS.length).toBe(6);
    const markup = renderToStaticMarkup(React.createElement(OnboardingModal, {
      isOpen: true,
      onClose: () => {},
      onSelectStarterTask: () => {},
    }));
    expect(markup).toContain("Setup &amp; Onboarding Guide");
    expect(markup).toContain("Cloudflare Workers Paid &amp; Container Sandbox");
    expect(markup).toContain("Cloudflare AI Gateway &amp; Stored BYOK Keys");
    expect(markup).toContain("Cloudflare Access &amp; Webhook Bypass Policies");
    expect(markup).toContain("GitHub Personal Access Token &amp; Repo Scoping");
    expect(markup).toContain("First Live Run &amp; Approval Gate");
    expect(markup).toContain("All (6)");
    // Nothing is verified before /api/setup/status answers, so no step starts done.
    expect(markup).toContain("Pending (6)");
    expect(markup).toContain("Completed (0)");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('role="checkbox"');
  });
  it("renders sidebar toggle button and keyboard shortcuts for sidebar", () => {
    const markup = renderApp();
    expect(markup).toContain('aria-label="Collapse sidebar"');
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('aria-label="Open sessions"');
  });

  it("renders Tooltip component wrapping trigger elements", () => {
    const tooltipMarkup = renderToStaticMarkup(
      React.createElement(
        Tooltip,
        {
          content: "Test Tooltip Content",
          shortcut: "⌘T",
          children: React.createElement("button", { type: "button" }, "Hover Me"),
        }
      )
    );
    expect(tooltipMarkup).toContain("<button");
    expect(tooltipMarkup).toContain("Hover Me");
  });
});
