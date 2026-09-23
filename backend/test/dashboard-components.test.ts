// SSR smoke tests for the T14 visual-consistency sweep: every swept surface
// must render to static markup without a live backend (same pattern as the
// InboxTab/MemoryTab block in inbox-tab.test.ts). Asserts the markup carries
// the content a user lands on — not just that render didn't throw.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ApprovalCard } from "../src/dashboard/components/ApprovalCard";
import { ArchitectureView } from "../src/dashboard/components/ArchitectureView";
import { OnboardingModal } from "../src/dashboard/components/OnboardingModal";
import {
  SessionsSidebar,
  type SessionItem,
} from "../src/dashboard/components/SessionsSidebar";
import { TaskComposer } from "../src/dashboard/components/TaskComposer";
import type { AgentPrincipal } from "../src/dashboard/types";

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
    // workers-paid is pre-completed + expanded by default → its detail toggle
    // reads "Mark as Incomplete"; pending steps expose the checkbox affordance.
    expect(html).toContain("Mark as Incomplete");
    expect(html).toContain("Mark Cloudflare AI Gateway &amp; Stored BYOK Keys as complete");
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

  it("ArchitectureView renders the static architecture map", () => {
    const html = renderToStaticMarkup(React.createElement(ArchitectureView));
    expect(html.length).toBeGreaterThan(0);
  });
});
