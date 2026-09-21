import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ERROR_FAMILY_STATUSES,
  STATUS_CHIP_CLASSES,
  statusLabel,
} from "../src/dashboard/ui-helpers";
import { statusDotClass } from "../src/dashboard/components/SessionsSidebar";
import { RunRegistryView } from "../src/dashboard/components/RunRegistryView";
import type { RetainedRun } from "../src/dashboard/types";

describe("dashboard unknown status", () => {
  it("exposes an amber chip and 'Unknown' label", () => {
    expect(statusLabel("unknown")).toBe("Unknown");
    const chip = STATUS_CHIP_CLASSES["unknown"];
    expect(chip).toBeDefined();
    expect(chip).toContain("text-[#d97706]");
    expect(chip).toContain("border-[#d97706]");
    expect(chip).toContain("bg-[#d97706]");
  });

  it("groups unknown with the error family for filters and counters", () => {
    expect(ERROR_FAMILY_STATUSES.has("unknown")).toBe(true);
    for (const s of ["error", "aborted", "cancelled"]) expect(ERROR_FAMILY_STATUSES.has(s)).toBe(true);
    for (const s of ["completed", "pending", "running"]) expect(ERROR_FAMILY_STATUSES.has(s)).toBe(false);
  });

  it("gives unknown its own sidebar dot, distinct from error red and completed green", () => {
    const base = { id: "s1", title: "t", repoName: "o/r", status: "unknown", live: false, updatedAt: 0 };
    const unknown = statusDotClass(base);
    const error = statusDotClass({ ...base, status: "error" });
    const completed = statusDotClass({ ...base, status: "completed" });
    const pending = statusDotClass({ ...base, status: "pending" });
    expect(unknown).toContain("#d97706");
    expect(unknown).not.toBe(error);
    expect(unknown).not.toBe(completed);
    expect(unknown).not.toBe(pending);
  });

  it("renders an unknown run with amber styling and the Unknown label", () => {
    const runs: RetainedRun[] = [{
      runId: "run-unk",
      sandboxId: "sb-unk",
      repoUrl: "https://github.com/owner/repo",
      task: "Ambiguous run",
      baseBranch: "main",
      publishPullRequest: false,
      status: "unknown",
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    }];
    const markup = renderToStaticMarkup(React.createElement(RunRegistryView, {
      runs,
      onInspectVM: () => {},
      onReuseParams: () => {},
      onCancelRun: () => {},
      onClearHistory: () => {},
      onRefresh: () => {},
    }));
    expect(markup).toContain("Unknown");
    expect(markup).toContain("#d97706");
  });
});
