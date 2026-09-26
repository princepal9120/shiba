// SSR smoke tests for the T14 visual-consistency sweep: every swept surface
// must render to static markup without a live backend (same pattern as the
// InboxTab/MemoryTab block in inbox-tab.test.ts). Asserts the markup carries
// the content a user lands on — not just that render didn't throw.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "../../frontend/src/components/ApprovalCard";
import { OnboardingModal } from "../../frontend/src/components/OnboardingModal";
import { AgentsView } from "../../frontend/src/components/AgentsView";
import {
  SessionsSidebar,
  type SessionItem,
} from "../../frontend/src/components/SessionsSidebar";
import { TaskComposer } from "../../frontend/src/components/TaskComposer";
import { AppNavRail } from "../../frontend/src/components/AppNavRail";
import { DiffView } from "../../frontend/src/components/DiffView";
import { ApprovalsView } from "../../frontend/src/components/ApprovalsView";
import type { AgentPrincipal } from "../../frontend/src/types";

const sessions: SessionItem[] = [
  {
    id: "live",
    title: "Ship the inbox tab",
    repoName: "shiba",
    status: "live",
    updatedAt: 1_000,
    live: true,
  },
  {
    id: "run-1",
    title: "Fix flaky audit test",
    repoName: "shiba",
    status: "completed",
    updatedAt: 2_000,
  },
];

const agents: AgentPrincipal[] = [
  { principal: "ci-bot", scopes: ["emails:read"], created: 1_000, live: true },
];

describe("dashboard components SSR (T14 sweep)", () => {
  it("SessionsSidebar renders session groups, agents, and the footer setup chip", () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionsSidebar, {
        sessions,
        agents,
        selectedId: "live",
        onSelect: () => {},
        onNewTask: () => {},
        connectionLabel: "Connected",
        connectionTone: "ok",
        setupDone: 2,
        setupTotal: 6,
        onOpenSetup: () => {},
      }),
    );
    expect(html).toContain("New task");
    expect(html).toContain("Active");
    expect(html).toContain("Ship the inbox tab");
    expect(html).toContain("Recent");
    expect(html).toContain("Fix flaky audit test");
    expect(html).toContain("Agents");
    expect(html).toContain("ci-bot");
    expect(html).toContain("Setup 2/6");
  });

  it("SessionsSidebar renders the empty state when there are no sessions", () => {
    const html = renderToStaticMarkup(
      React.createElement(SessionsSidebar, {
        sessions: [],
        agents: [],
        selectedId: null,
        onSelect: () => {},
        onNewTask: () => {},
        connectionLabel: "Connecting",
        connectionTone: "pending",
        setupDone: null,
        setupTotal: 6,
        onOpenSetup: () => {},
      }),
    );
    expect(html).toContain("No sessions yet");
  });

  it("OnboardingModal renders the step checklist with per-step completion buttons", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingModal, { isOpen: true, onClose: () => {} }),
    );
    expect(html).toContain("Setup &amp; Onboarding Guide");
    expect(html).toContain("Cloudflare Workers Paid");
    // workers-paid is expanded by default but not done until /api/setup/status proves it.
    expect(html).toContain("Mark as Completed ✓");
    expect(html).toContain("Mark Cloudflare AI Gateway &amp; Stored BYOK Keys as complete");
    expect(html).toContain("Connect a cloud agent mailbox");
    expect(html).toContain("Open Inbox setup");
    expect(html).not.toContain("Mark all done");
    expect(html).not.toContain("All systems configured!");
  });

  it("AgentsView shows a usable, scoped token command and no false connection claim", () => {
    const html = renderToStaticMarkup(React.createElement(AgentsView));
    expect(html).toContain("--agent scout --scopes email:read");
    expect(html).toContain("Minting without --write only prints a token");
    expect(html).toContain("Open Inbox setup");
    expect(html).not.toContain("--principal=agent-1");
    expect(html).not.toContain("MCP 1.30.0 Active");
  });

  it("OnboardingModal renders nothing while closed", () => {
    const html = renderToStaticMarkup(
      React.createElement(OnboardingModal, { isOpen: false, onClose: () => {} }),
    );
    expect(html).toBe("");
  });

  it("TaskComposer renders the composer card with repo, branch, harness, and PR fields", () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskComposer, {
        repoUrl: "github.com/princepal9120/shiba",
        task: "Fix the inbox badge",
        baseBranch: "main",
        publishPullRequest: true,
        harness: "opencode",
        busy: false,
        isSubmitting: false,
        clearing: false,
        onRepoUrlChange: () => {},
        onTaskChange: () => {},
        onBaseBranchChange: () => {},
        onPublishPullRequestChange: () => {},
        onHarnessChange: () => {},
        onSubmit: () => {},
        onClear: () => {},
      }),
    );
    expect(html).toContain("task-composer");
    expect(html).toContain("github.com/princepal9120/shiba");
    expect(html).toContain("Fix the inbox badge");
    expect(html).toContain("Create PR");
    expect(html).toContain("OpenCode");
  });

  it("ApprovalCard renders the approve/reject gate for a pending tool call", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalCard, {
        approval: {
          messageId: "msg-1",
          toolCallId: "call-1",
          approvalId: "apv-1",
          tool: "send_email",
          input: { to_addr: "alice@example.com" },
        },
        decided: false,
        onDecideApproval: () => {},
        agentName: "ci-bot",
      }),
    );
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(html).toContain("send_email");
  });

  it("AppNavRail renders promoted views without the retired Architecture entry", () => {
    const html = renderToStaticMarkup(
      React.createElement(AppNavRail, {
        activeView: "diff",
        onNavigate: () => {},
        activeSandboxCount: 2,
        pendingApprovalCount: 3,
        setupDone: 4,
        setupTotal: 6,
        onOpenSetup: () => {},
        onOpenShortcuts: () => {},
      })
    );
    expect(html).toContain("Diff");
    expect(html).toContain("Approvals");
    expect(html).toContain("Mailbox");
    expect(html).toContain("Memory");
    expect(html).not.toContain("Architecture");
    expect(html).toContain("3"); // Pending approval badge
    expect(html).toContain("aria-current");
  });

  it("DiffView renders diff inspection and run switcher", () => {
    const runs = [
      {
        runId: "run-42",
        sandboxId: "sb-42",
        repoUrl: "https://github.com/shiba/core",
        task: "Refactor router to standalone views",
        baseBranch: "main",
        publishPullRequest: true,
        status: "completed",
        createdAt: Date.now() - 5000,
        updatedAt: Date.now(),
        diff: `diff --git a/routes.ts b/routes.ts
@@ -1,3 +1,4 @@
+import { DiffView } from "./DiffView";`, 
      },
    ];

    const html = renderToStaticMarkup(
      React.createElement(DiffView, {
        runs,
        selectedRunId: "run-42",
      })
    );
    expect(html).toContain("Diff &amp; Patch Inspector");
    expect(html).toContain("run-42");
    expect(html).toContain("Refactor router to standalone views");
    expect(html).toContain("DiffView");
  });

  it("ApprovalsView renders pending approvals, stored DO approvals, and outcomes", () => {
    const html = renderToStaticMarkup(
      React.createElement(ApprovalsView, {
        pendingApprovals: [
          {
            messageId: "msg-1",
            toolCallId: "call-1",
            approvalId: "apv-tool",
            tool: "run_sandbox",
            input: { command: "pnpm test" },
          },
        ],
        decisions: {},
        onDecideApproval: () => {},
        storedApprovals: [
          {
            approvalId: "apv-email",
            kind: "email_send",
            status: "pending",
            repoUrl: "contact@example.com",
            task: "Send outbound email to user",
            createdAt: Date.now() - 1000,
            threadKey: "mail-thread-1",
          },
        ],
        storedDecisions: {},
        decidedStoredApprovals: [
          {
            approvalId: "apv-done",
            kind: "run",
            status: "approved",
            repoUrl: "https://github.com/shiba/core",
            task: "Run safe migrations",
            createdAt: Date.now() - 10000,
            threadKey: "main",
            execution: { status: "executed", executedAt: Date.now() },
          },
        ],
        storedApprovalsError: null,
        onDecideStoredApproval: () => {},
      })
    );
    expect(html).toContain("Approvals &amp; Decision Center");
    expect(html).toContain("2 waiting");
    expect(html).toContain("run_sandbox");
    expect(html).toContain("Email send");
    expect(html).toContain("Recent Outcomes &amp; Decided Actions");
    expect(html).toContain("Executed");
  });
});
