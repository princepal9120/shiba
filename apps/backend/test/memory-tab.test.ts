import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MemoryTab,
  sourceChipClass,
  formatRecallScore,
  filterFactsBySource,
  filterFactsByAgent,
  type MemoryTabProps,
} from "../../frontend/src/components/MemoryTab";
import type { MemoryFact, MemorySession } from "../../frontend/src/types";

const mockFactRun: MemoryFact = {
  id: "fact-1",
  fact: "Prefers pnpm over npm",
  source: "run",
  agent: "intern",
  score: 0.94,
  created_at: 1710000000000,
};

const mockFactEmail: MemoryFact = {
  id: "fact-2",
  fact: "Production deployment approval required for dev@example.com",
  source: "email",
  agent: "operator",
  score: 0.82,
  created_at: 1710000050000,
};

const mockSession: MemorySession = {
  id: "ses-101",
  agent: "intern",
  started_at: 1710000000000,
  summary: "Completed migration of API routes to effect-runtime.",
};

describe("MemoryTab helpers", () => {
  it("sourceChipClass assigns distinct tokens for run, email, and fallback sources", () => {
    const runClass = sourceChipClass("run");
    expect(runClass).toContain("text-[#1c1cc8]");
    expect(runClass).toContain("bg-[#0000a8]/10");

    const emailClass = sourceChipClass("email");
    expect(emailClass).toContain("text-[#b45309]");
    expect(emailClass).toContain("bg-[#f99c00]/10");

    const otherClass = sourceChipClass("manual");
    expect(otherClass).toContain("text-[#6a6f63]");
  });

  it("formatRecallScore formats floating-point similarity scores", () => {
    expect(formatRecallScore(0.876)).toBe("0.88");
    expect(formatRecallScore(0.5)).toBe("0.50");
    expect(formatRecallScore(undefined)).toBe("");
    expect(formatRecallScore(NaN)).toBe("");
  });

  it("filterFactsBySource filters by source correctly", () => {
    const facts = [mockFactRun, mockFactEmail];
    expect(filterFactsBySource(facts, "all")).toEqual(facts);
    expect(filterFactsBySource(facts, "")).toEqual(facts);
    expect(filterFactsBySource(facts, "run")).toEqual([mockFactRun]);
    expect(filterFactsBySource(facts, "email")).toEqual([mockFactEmail]);
    expect(filterFactsBySource(facts, "unknown")).toEqual([]);
  });

  it("filterFactsByAgent filters by agent correctly", () => {
    const facts = [mockFactRun, mockFactEmail];
    expect(filterFactsByAgent(facts, "all")).toEqual(facts);
    expect(filterFactsByAgent(facts, "")).toEqual(facts);
    expect(filterFactsByAgent(facts, "intern")).toEqual([mockFactRun]);
    expect(filterFactsByAgent(facts, "operator")).toEqual([mockFactEmail]);
    expect(filterFactsByAgent(facts, "ghost")).toEqual([]);
  });
});

describe("MemoryTab component rendering", () => {
  it("renders the loading state on mount when no initial state is provided", () => {
    const html = renderToStaticMarkup(React.createElement(MemoryTab));
    expect(html).toContain("Durable Agent Memory");
    expect(html).toContain("Loading memory…");
  });

  it("renders seeded facts with provenance chips, agent tags, and score pills", () => {
    const props: MemoryTabProps = {
      initialFacts: [mockFactRun, mockFactEmail],
      initialSessions: [mockSession],
    };
    const html = renderToStaticMarkup(React.createElement(MemoryTab, props));
    expect(html).toContain("Durable Agent Memory");
    expect(html).toContain("2");
    expect(html).toContain("facts banked");
    expect(html).toContain("Prefers pnpm over npm");
    expect(html).toContain("Production deployment approval required");
    expect(html).toContain("RUN");
    expect(html).toContain("EMAIL");
    expect(html).toContain("@intern");
    expect(html).toContain("@operator");
    expect(html).toContain("Score 0.94");
    expect(html).toContain("Score 0.82");
    expect(html).toContain("Forget");
  });

  it("renders empty state when facts list is empty", () => {
    const props: MemoryTabProps = {
      initialFacts: [],
      initialSessions: [],
    };
    const html = renderToStaticMarkup(React.createElement(MemoryTab, props));
    expect(html).toContain("No facts banked yet.");
    expect(html).toContain("0");
    expect(html).toContain("facts banked");
  });

  it("renders accessible navigation tabs for Facts and Sessions", () => {
    const props: MemoryTabProps = {
      initialFacts: [mockFactRun],
      initialSessions: [mockSession],
    };
    const html = renderToStaticMarkup(React.createElement(MemoryTab, props));
    expect(html).toContain("Banked Facts (1)");
    expect(html).toContain("Recorded Sessions (1)");
    expect(html).toContain("Recall a fact");
  });
});
