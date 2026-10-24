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
  createMcpHandler: () => ({
    fetch: async () => Response.json({ mcp: "served" }, { status: 200 }),
    notify: {},
  }),
}));

import worker from "../src/index.js";
import type { Env } from "../src/env.js";

class FakeKV {
  async get() {
    return null;
  }
  async put() {}
  async delete() {}
}

const ctx = { waitUntil: (p: Promise<unknown>) => p } as unknown as ExecutionContext;

describe("worker /api/providers", () => {
  it("lists ACP providers for a loopback caller without subscription flags", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/providers"),
      { AGENT_TOKENS: new FakeKV() } as unknown as Env,
      ctx,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { providers: Array<{ id: string; protocol: string }> };
    expect(body.providers.map((provider) => provider.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "grok",
      "cursor",
    ]);
    expect(body.providers.find((provider) => provider.id === "claude")?.protocol).toBe("acp");
  });
});
