import { describe, expect, it, vi } from "vitest";

vi.mock("agents/routing", () => ({
  getAgentByName: async (ns: { get?: (name: string) => unknown }, name: string) => {
    if (ns && typeof ns.get === "function") {
      return ns.get(name);
    }
    return { fetch: async () => new Response("{}", { status: 404 }) };
  },
}));

import {
  aggregateUsageByDay,
  buildUsageReport,
  parseUsageBudget,
  parseUsageDays,
  USAGE_DAYS_DEFAULT,
  USAGE_DAYS_MAX,
} from "../src/usage.js";
import { handleUsage } from "../src/usage-routes.js";
import { mergeRunUsage } from "@shiba/shared";
import { createRun, type DelegatedRun } from "../src/runs.js";
import { evidenceFor } from "./seeding.js";
import type { Env } from "../src/env.js";

const INPUT = {
  repoUrl: "https://github.com/o/r",
  task: "fix",
  baseBranch: "main",
  publishPullRequest: false,
};

function makeRun(overrides: Partial<DelegatedRun>): DelegatedRun {
  return {
    ...createRun({
      runId: "r1",
      sandboxId: "s1",
      ...INPUT,
      approval: evidenceFor(INPUT),
      now: 1000,
    }),
    ...overrides,
  };
}

const DAY = 24 * 60 * 60 * 1000;
// 2026-10-02 12:00 UTC — inside today's bucket.
const NOW = Date.UTC(2026, 9, 2, 12);

describe("mergeRunUsage — delta accumulation", () => {
  it("sums fields only when a side reports them", () => {
    expect(mergeRunUsage(undefined, { inputTokens: 10 })).toEqual({ inputTokens: 10 });
    expect(
      mergeRunUsage({ inputTokens: 10, outputTokens: 5 }, { inputTokens: 3, costUsd: 0.5 }),
    ).toEqual({ inputTokens: 13, outputTokens: 5, costUsd: 0.5 });
    expect(mergeRunUsage({ outputTokens: 2 }, {})).toEqual({ outputTokens: 2 });
    expect(mergeRunUsage(undefined, undefined)).toBeUndefined();
  });
});

describe("aggregateUsageByDay", () => {
  it("groups by harness/provider/role over UTC days, counting only usage-reporting runs", () => {
    const report = aggregateUsageByDay(
      [
        makeRun({
          runId: "a",
          updatedAt: NOW,
          usage: { inputTokens: 100, outputTokens: 40, costUsd: 0.01 },
          route: {
            purpose: "coding",
            connectionId: null,
            modelId: "google/gemini-3",
            harness: "opencode",
            policyVersion: 1,
          },
        }),
        makeRun({
          runId: "b",
          updatedAt: NOW + 60_000,
          usage: { inputTokens: 50, outputTokens: 10 },
          route: {
            purpose: "coding",
            connectionId: null,
            modelId: "google/gemini-3",
            harness: "opencode",
            policyVersion: 1,
          },
        }),
        // Different harness + provider lands in its own group.
        makeRun({
          runId: "c",
          updatedAt: NOW,
          usage: { inputTokens: 5, outputTokens: 5 },
          route: {
            purpose: "coding",
            connectionId: null,
            modelId: "openai/gpt-5",
            harness: "codex",
            policyVersion: 1,
          },
        }),
        // Yesterday's bucket.
        makeRun({
          runId: "d",
          updatedAt: NOW - DAY,
          usage: { inputTokens: 7 },
          route: {
            purpose: "coding",
            connectionId: null,
            modelId: "anthropic/claude-x",
            harness: "claude-code",
            policyVersion: 1,
          },
        }),
        // No usage reported — contributes nothing.
        makeRun({ runId: "e", updatedAt: NOW }),
        // Predates route freezing — groups under nulls.
        makeRun({ runId: "f", updatedAt: NOW, usage: { outputTokens: 3 } }),
        // Outside the 30-day window.
        makeRun({ runId: "g", updatedAt: NOW - 40 * DAY, usage: { inputTokens: 9 } }),
      ],
      { now: NOW },
    );

    expect(report.map((day) => day.date)).toEqual(["2026-10-02", "2026-10-01"]);
    const today = report[0];
    if (today === undefined) throw new Error("today bucket missing");
    expect(today.runs).toBe(4); // a, b, c, f — e has no usage, g is out of window
    expect(today.inputTokens).toBe(155);
    expect(today.outputTokens).toBe(58);
    expect(today.costUsd).toBeCloseTo(0.01);
    expect(today.groups).toHaveLength(3);
    const opencodeGroup = today.groups.find((g) => g.harness === "opencode");
    expect(opencodeGroup).toMatchObject({
      provider: "google",
      role: "coding",
      runs: 2,
      inputTokens: 150,
      outputTokens: 50,
      costUsd: 0.01,
    });
    const codexGroup = today.groups.find((g) => g.harness === "codex");
    expect(codexGroup?.provider).toBe("openai");
    const routeless = today.groups.find((g) => g.harness === null);
    expect(routeless).toMatchObject({ provider: null, role: null, runs: 1, outputTokens: 3 });
    expect(routeless?.inputTokens).toBeUndefined();

    const yesterday = report[1];
    if (yesterday === undefined) throw new Error("yesterday bucket missing");
    expect(yesterday.runs).toBe(1);
    expect(yesterday.inputTokens).toBe(7);
    expect(yesterday.costUsd).toBeUndefined();
  });

  it("honors the days window bound", () => {
    const report = aggregateUsageByDay(
      [makeRun({ updatedAt: NOW - 10 * DAY, usage: { inputTokens: 1 } })],
      { days: 7, now: NOW },
    );
    expect(report).toEqual([]);
  });
});

describe("parseUsageBudget / parseUsageDays", () => {
  it("budget is null when unset, malformed, or negative — a number when set", () => {
    expect(parseUsageBudget({})).toBeNull();
    expect(parseUsageBudget({ USAGE_BUDGET_USD: "50" })).toBe(50);
    expect(parseUsageBudget({ USAGE_BUDGET_USD: "12.5" })).toBe(12.5);
    expect(parseUsageBudget({ USAGE_BUDGET_USD: "abc" })).toBeNull();
    expect(parseUsageBudget({ USAGE_BUDGET_USD: "-1" })).toBeNull();
    expect(parseUsageBudget({ USAGE_BUDGET_USD: "  " })).toBeNull();
  });

  it("days defaults, floors, and caps", () => {
    expect(parseUsageDays(null)).toBe(USAGE_DAYS_DEFAULT);
    expect(parseUsageDays("7")).toBe(7);
    expect(parseUsageDays("0")).toBe(USAGE_DAYS_DEFAULT);
    expect(parseUsageDays("x")).toBe(USAGE_DAYS_DEFAULT);
    expect(parseUsageDays("10000")).toBe(USAGE_DAYS_MAX);
  });
});

describe("GET /api/usage", () => {
  const seededRuns = [
    makeRun({
      runId: "u1",
      updatedAt: NOW,
      usage: { inputTokens: 200, outputTokens: 90, costUsd: 0.25 },
      route: {
        purpose: "coding",
        connectionId: null,
        modelId: "google/gemini-3",
        harness: "opencode",
        policyVersion: 1,
      },
    }),
    makeRun({ runId: "u2", updatedAt: NOW }), // no usage — counted nowhere
  ];

  const envWithRuns = (extra: Partial<Env> = {}): Env =>
    ({
      CodingOrchestrator: {
        get: () => ({
          fetch: async () => Response.json({ runs: seededRuns }),
        }),
      },
      ...extra,
    }) as unknown as Env;

  it("returns daily aggregates with the budget line when USAGE_BUDGET_USD is set", async () => {
    const response = await handleUsage(
      new Request("http://localhost/api/usage"),
      envWithRuns({ USAGE_BUDGET_USD: "5" }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as {
      timezone: string;
      budgetUsd: number | null;
      days: { date: string; runs: number; inputTokens?: number; costUsd?: number }[];
    };
    expect(body.timezone).toBe("UTC");
    expect(body.budgetUsd).toBe(5);
    const today = body.days.find((d) => d.date === "2026-10-02");
    expect(today?.runs).toBe(1);
    expect(today?.inputTokens).toBe(200);
    expect(today?.costUsd).toBe(0.25);
  });

  it("budgetUsd is null when the env var is absent — no budget card downstream", async () => {
    const response = await handleUsage(new Request("http://localhost/api/usage"), envWithRuns());
    const body = (await response!.json()) as { budgetUsd: number | null };
    expect(body.budgetUsd).toBeNull();
  });

  it("rejects non-GET and passes a dead run store through", async () => {
    const post = await handleUsage(new Request("http://localhost/api/usage", { method: "POST" }), envWithRuns());
    expect(post?.status).toBe(405);
    const env = {
      CodingOrchestrator: { get: () => ({ fetch: async () => new Response("nope", { status: 503 }) }) },
    } as unknown as Env;
    const dead = await handleUsage(new Request("http://localhost/api/usage"), env);
    expect(dead?.status).toBe(503);
    expect(await handleUsage(new Request("http://localhost/api/not-usage"), envWithRuns())).toBeNull();
  });

  it("401s when Access is configured and the request carries no identity", async () => {
    const env = envWithRuns({ REQUIRE_ACCESS: "1" } as Partial<Env>);
    const response = await handleUsage(new Request("http://localhost/api/usage"), env);
    expect(response?.status).toBe(401);
  });
});
