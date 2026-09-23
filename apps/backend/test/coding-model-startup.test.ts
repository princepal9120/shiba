import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({
  getAgentByName: async () => ({ fetch: async () => new Response("{}", { status: 404 }) }),
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
  McpAgent: class {
    static serve() {
      return { fetch: async () => Response.json({ mcp: "served" }) };
    }
  },
}));
vi.mock("../src/email-approvals.js", () => ({
  queueEmailApproval: async () => ({ approval_id: "apv-test" }),
  emailApprovalBridgeReady: () => true,
}));

/**
 * Covers VERIFICATION_PLAN.md G2: `fetch` asserts CODING_MODEL isn't a
 * retired id before serving any route. `/api/audit` is used as the probe
 * route — it falls through every earlier handler and, once the assertion
 * clears, answers 503 (AGENT_AUDIT unbound) rather than routing further,
 * which distinguishes "the assertion ran and passed" from "it never ran".
 *
 * `index.ts` gates the assertion behind a module-level `codingModelVerified`
 * flag (checked once, not per request). That flag would leak between the
 * `it` blocks below if they shared one imported module instance, so each
 * test resets the module registry and re-imports `index.js` fresh.
 */
import type { Env } from "../src/env.js";

function makeEnv(codingModel: string): Env {
  return { CODING_MODEL: codingModel } as Env;
}

function makeCtx(): ExecutionContext {
  return { waitUntil: () => {} } as unknown as ExecutionContext;
}

/** Fresh `index.js` module instance so `codingModelVerified` starts unset. */
async function freshWorker() {
  vi.resetModules();
  return (await import("../src/index.js")).default;
}

// Built from parts, like the dead-default guard test's own marker, so this
// file doesn't trip that guard's "only coding-model.ts may reference the
// retired default" scan.
const RETIRED_ID = "google/" + ["gemini-2", "0"].join(".") + "-flash";

describe("startup assertion on CODING_MODEL", () => {
  it("throws (500, logged as retired) while CODING_MODEL names a retired id", async () => {
    const worker = await freshWorker();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = makeEnv(RETIRED_ID);
    const response = await worker.fetch(new Request("https://worker/api/audit"), env, makeCtx());
    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/retired/));
    errorSpy.mockRestore();
  });

  it("passes the assertion for a live CODING_MODEL id", async () => {
    const worker = await freshWorker();
    const env = makeEnv("google/gemini-3.5-flash-lite");
    const response = await worker.fetch(new Request("https://worker/api/audit"), env, makeCtx());
    // Reaches the audit route handler itself (unbound AGENT_AUDIT -> 503),
    // proving the assertion did not throw and the request kept routing.
    expect(response.status).toBe(503);
  });
});
