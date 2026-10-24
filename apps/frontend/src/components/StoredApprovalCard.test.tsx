// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

afterEach(() => cleanup());
import { StoredApprovalCard } from "./WorkspacePanel";
import type { StoredApproval } from "../types";

const approval: StoredApproval = {
  approvalId: "ap-1",
  threadKey: "",
  repoUrl: "https://github.com/o/r",
  task: "Ship fix",
  createdAt: Date.now(),
  status: "pending",
  kind: "run",
  publishPullRequest: true,
  reviewAfterPublish: true,
};

describe("StoredApprovalCard", () => {
  it("explains approve vs reject before decision", () => {
    render(<StoredApprovalCard approval={approval} decided={false} onDecide={vi.fn()} />);
    expect(screen.getByText(/Approve to start the run/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  it("labels buttons after approval", () => {
    render(
      <StoredApprovalCard approval={approval} decided decision={true} onDecide={vi.fn()} />,
    );
    const approved = screen.getByRole("button", { name: "Approved" }) as HTMLButtonElement;
    expect(approved.disabled).toBe(true);
    expect(approved.closest("div")?.querySelectorAll("button")).toHaveLength(2);
  });

  it("shows the frozen route, effort included, so the approver sees what will run", () => {
    render(
      <StoredApprovalCard
        approval={{
          ...approval,
          route: {
            purpose: "coding",
            connectionId: null,
            modelId: "openai/gpt-5",
            harness: "codex",
            policyVersion: 0,
            reasoningEffort: "high",
          },
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("codex · openai/gpt-5 · effort high · via deployment default")).toBeTruthy();
  });

  it("renders Env: DATABASE_URL for envNames: ['DATABASE_URL'] and never renders a value", () => {
    const secret = "postgres://user:secret-password@host/db";
    render(
      <StoredApprovalCard
        approval={{
          ...approval,
          envNames: ["DATABASE_URL"],
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("DATABASE_URL")).toBeTruthy();
    expect(screen.getByText("Env:").parentElement?.textContent).toContain("Env: DATABASE_URL");
    expect(screen.queryByText(secret)).toBeNull();
  });

  it("renders the Setup line when runSetup: true and omits it otherwise", () => {
    const { rerender } = render(
      <StoredApprovalCard
        approval={{
          ...approval,
          runSetup: true,
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.getByText("runs .shiba/setup.json initialize")).toBeTruthy();
    expect(screen.getByText("Setup:").parentElement?.textContent).toContain(
      "Setup: runs .shiba/setup.json initialize",
    );

    rerender(
      <StoredApprovalCard
        approval={{
          ...approval,
          runSetup: false,
        }}
        decided={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByText("Setup:")).toBeNull();
    expect(screen.queryByText(/runs \.shiba\/setup\.json initialize/)).toBeNull();
  });
});
