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

import { App } from "../dashboard/src/app";
import { VMInspector } from "../dashboard/src/components/VMInspector";
import { RunRegistryView } from "../dashboard/src/components/RunRegistryView";
import { AutomationsView } from "../dashboard/src/components/AutomationsView";
import { ArchitectureView } from "../dashboard/src/components/ArchitectureView";
import { OnboardingModal, ONBOARDING_STEPS } from "../dashboard/src/components/OnboardingModal";
import { TaskForm } from "../web/src/components/TaskForm";

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
  it("shows useful empty states when no task has started", () => {
    const markup = renderApp();

    expect(markup).toContain("No messages yet. Submit a task to start.");
    expect(markup).toContain("Setup Guide");
    expect(markup).toContain("View Setup Checklist &amp; Architecture");
    expect(markup).toContain("No live runs. Approved tasks appear here while they execute.");
    expect(markup).toContain("No retained runs on the orchestrator yet.");
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

    expect(markup).toContain("Waiting for your approval");
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
    expect(markup).toContain("error");
    expect(markup).toContain("sandbox failed");
    expect(markup).toContain("The sandbox exited early.");
    expect(markup).toContain("exit code 1");
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

    expect(appMarkup).toContain('data-testid="task-submission-form"');
    expect(appMarkup).toContain('type="url"');
    expect(appMarkup).toContain("<textarea");
    expect(appMarkup).toContain('type="checkbox"');
  });

  it("renders diff output for completed runs", () => {
    mocks.runsById = {
      "run-diff-1": {
        runId: "run-diff-1",
        status: "completed",
        agentType: "coding-agent",
        parentToolCallId: "call-1",
        parts: [{ text: "done" }],
        summary: "Done.",
        diff: "diff --git a/src/a.ts b/src/a.ts\n+added line\n-removed line",
      },
    };

    const markup = renderApp();

    expect(markup).toContain("run-diff-1");
    expect(markup).toContain("completed");
    expect(markup).toContain("diff --git");
    expect(markup).toContain("added line");
    expect(markup).toContain("removed line");
    expect(markup).toContain("<pre");
    expect(markup).toContain("<code");
  });

  it("renders the top navigation bar with all architectural views", () => {
    const markup = renderApp();
    expect(markup).toContain("Tasks");
    expect(markup).toContain("VM");
    expect(markup).toContain("Runs");
    expect(markup).toContain("Automations");
    expect(markup).toContain("Architecture");
  });

  it("renders VMInspector with workspace inspection, diff and terminal tabs", () => {
    const runs = [
      {
        runId: "run-vm-1",
        sandboxId: "sb-1",
        repoUrl: "https://github.com/owner/repo",
        task: "Build feature",
        baseBranch: "main",
        publishPullRequest: false,
        status: "completed",
        createdAt: Date.now() - 60000,
        updatedAt: Date.now(),
        summary: "Feature built successfully.",
        diff: "diff --git a/app.ts b/app.ts\n+const x = 1;",
      },
    ];
    const markup = renderToStaticMarkup(React.createElement(VMInspector, { runs }));
    expect(markup).toContain("VM Inspector");
    expect(markup).toContain("Changes &amp; Diff");
    expect(markup).toContain("Workspace Files");
    expect(markup).toContain("Terminal &amp; Exec");
    expect(markup).toContain("Web Preview");
    expect(markup).toContain("Share VM View");
    expect(markup).toContain("diff --git");
  });

  it("renders RunRegistryView with stats, search and filters", () => {
    const runs = [
      {
        runId: "run-reg-1",
        sandboxId: "sb-1",
        repoUrl: "https://github.com/owner/repo",
        task: "Fix bug",
        baseBranch: "main",
        publishPullRequest: true,
        status: "completed",
        createdAt: Date.now() - 30000,
        updatedAt: Date.now(),
      },
    ];
    const markup = renderToStaticMarkup(React.createElement(RunRegistryView, {
      runs,
      onInspectVM: () => {},
      onReuseParams: () => {},
      onCancelRun: () => {},
      onClearHistory: () => {},
      onRefresh: () => {},
    }));
    expect(markup).toContain("Run Registry &amp; Workspaces");
    expect(markup).toContain("Total Runs");
    expect(markup).toContain("Inspect Virtual Machine");
    expect(markup).toContain("Fix bug");
  });

  it("renders AutomationsView with webhook endpoints", () => {
    const markup = renderToStaticMarkup(React.createElement(AutomationsView));
    expect(markup).toContain("Automations &amp; Inbound Triggers");
    expect(markup).toContain("/api/github/webhook");
    expect(markup).toContain("/api/slack/command");
  });

  it("renders ArchitectureView with isolation boundaries", () => {
    const markup = renderToStaticMarkup(React.createElement(ArchitectureView));
    expect(markup).toContain("System Architecture &amp; Isolation Boundary");
    expect(markup).toContain("Isolated Sandbox VM");
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
    expect(markup).toContain("Pending (5)");
    expect(markup).toContain("Completed (1)");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('role="checkbox"');
  });
});
