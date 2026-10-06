import { beforeEach, describe, expect, it, vi } from "vitest";
import { HARNESS_IDS, queueRunInputSchema } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { CodingOrchestrator, type OrchestratorState, delegateInputSchema } from "../src/agents/orchestrator.js";
import { productionEnvStubs, setStateLikeProduction } from "./orchestrator-host.js";
import { agentCliCatalog } from "../src/harness/catalog.js";
import { HARNESS_DEFAULT_MODELS, HARNESSES, HARNESS_NAMES } from "../src/harness/index.js";
import { formatAgentToolInput, parseAgentToolInput } from "../src/opencode-input.js";
import { setSandboxHandleResolver } from "../src/sandbox/lifecycle.js";

const mocks = vi.hoisted(() => ({
  destroy: vi.fn(),
  execute: vi.fn(),
  keepAliveWhile: vi.fn((fn: () => Promise<unknown>) => fn()),
  schedule: vi.fn(async (..._args: unknown[]) => ({})),
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
    keepAliveWhile(fn: () => Promise<unknown>) {
      return mocks.keepAliveWhile(fn);
    }
    schedule(...args: unknown[]) {
      return mocks.schedule(...args);
    }
  },
}));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: mocks.execute }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
setSandboxHandleResolver(() => ({ destroy: mocks.destroy }));

function env(overrides: Partial<Env> = {}): Env {
  return { ...productionEnvStubs(), Sandbox: {}, GITHUB_TOKEN: "test-token", ...overrides } as Env;
}

function agent(overrides: Partial<Env> = {}) {
  return Object.assign(Object.create(CodingOrchestrator.prototype) as CodingOrchestrator, {
    env: env(overrides),
    state: { runs: [] } as OrchestratorState,
    setState(state: OrchestratorState) {
      setStateLikeProduction(this, state);
    },
  });
}

function queueRun(instance: CodingOrchestrator, harness: string) {
  return instance.onRequest(
    new Request("https://internal/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoUrl: "https://github.com/o/r",
        task: "fix",
        harness,
      }),
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.destroy.mockResolvedValue(undefined);
});

describe("harness registry parity", () => {
  it("keeps each registry key equal to its harness name and derives the name list", () => {
    for (const [key, harness] of Object.entries(HARNESSES)) {
      expect(harness.name).toBe(key);
    }
    expect(HARNESS_NAMES).toEqual(Object.keys(HARNESSES));
  });

  it("keeps shared harness ids equal to registered harnesses with runtimes", () => {
    const runnableNames = Object.entries(HARNESSES)
      .filter(([, harness]) => harness.capabilities().supportedRuntimes.length > 0)
      .map(([name]) => name)
      .sort();
    expect([...HARNESS_IDS].sort()).toEqual(runnableNames);
  });

  it("accepts every shared harness id in each input schema and the catalog", () => {
    const allSubscriptionsEnabled = {
      SHIBA_CLAUDE_SUBSCRIPTION: "1",
      SHIBA_CODEX_SUBSCRIPTION: "1",
      SHIBA_ANTIGRAVITY_SUBSCRIPTION: "1",
      SHIBA_CURSOR_SUBSCRIPTION: "1",
      SHIBA_DEVIN_SUBSCRIPTION: "1",
    };
    const catalogIds = new Set(agentCliCatalog(allSubscriptionsEnabled).map(({ id }) => id));

    for (const harness of HARNESS_IDS) {
      expect(
        delegateInputSchema.safeParse({
          repoUrl: "https://github.com/o/r",
          task: "fix",
          baseBranch: "main",
          publishPullRequest: false,
          harness,
        }).success,
      ).toBe(true);
      expect(
        queueRunInputSchema.safeParse({
          repoUrl: "https://github.com/o/r",
          task: "fix",
          harness,
        }).success,
      ).toBe(true);
      expect(
        parseAgentToolInput([
          {
            role: "user",
            text: formatAgentToolInput({
              repoUrl: "https://github.com/o/r",
              task: "fix",
              baseBranch: "main",
              publishPullRequest: false,
              sandboxId: "sbx-1",
              codingModel: "google/gemini-3.5-flash-lite",
              harness,
            }),
          },
        ]).harness,
      ).toBe(harness);
      expect(catalogIds).toContain(harness);
    }
  });

  it("keeps default-model keys and harness names reciprocal", () => {
    expect(Object.keys(HARNESS_DEFAULT_MODELS).sort()).toEqual([...HARNESS_NAMES].sort());
  });
});

describe("codex-subscription queue intake", () => {
  it("refuses intake without its opt-in flag before creating an approval", async () => {
    const instance = agent();
    const response = await queueRun(instance, "codex-subscription");
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/SHIBA_CODEX_SUBSCRIPTION|not enabled/i);
    expect(instance.state.pendingApprovals ?? []).toHaveLength(0);
  });

  it("queues intake when enabled and freezes the codex-subscription route", async () => {
    const instance = agent({ SHIBA_CODEX_SUBSCRIPTION: "1" });
    const response = await queueRun(instance, "codex-subscription");

    expect(response.status).toBe(200);
    expect((instance.state.pendingApprovals ?? [])[0]?.route?.harness).toBe("codex-subscription");
  });
});
