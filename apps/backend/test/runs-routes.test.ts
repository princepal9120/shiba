import { describe, expect, it, vi } from "vitest";

// The gateway strips inbound vouchers before proxying to the DO: assert on
// the exact Request the stub receives, not on handleRuns' response.
const forwarded = vi.hoisted(() => ({ requests: [] as Request[] }));
vi.mock("agents/routing", () => ({
  getAgentByName: async (_ns: unknown, _name: string) => ({
    fetch: async (request: Request) => {
      forwarded.requests.push(request);
      return Response.json({ runs: [] });
    },
  }),
  routeAgentRequest: async () => null,
}));
vi.mock("../src/request-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/request-auth.js")>();
  return {
    ...actual,
    isAuthorizedRequest: async () => true,
    resolveUserId: async () => "devin",
  };
});

import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import type { Env } from "../src/env.js";
import { handleRuns } from "../src/runs-routes.js";

const env = { CodingOrchestrator: {} } as unknown as Env;

describe("handleRuns voucher hygiene", () => {
  it("strips a forged agent-principal header before proxying to the DO", async () => {
    forwarded.requests.length = 0;
    const request = new Request("https://shiba.test/api/runs", {
      headers: { [AGENT_PRINCIPAL_HEADER]: "claude-code" },
    });
    const response = await handleRuns(request, env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests).toHaveLength(1);
    // The DO treats queuedBy and the /api/spine filter as worker-vouched;
    // an inbound copy is a forgery and must never reach it.
    const proxied = forwarded.requests[0];
    expect(proxied?.headers.get(AGENT_PRINCIPAL_HEADER)).toBeNull();
    expect(proxied?.headers.get(LOCAL_INTAKE_HEADER)).toBe("dashboard");
  });

  it("stamps the dashboard intake voucher over any inbound copy", async () => {
    forwarded.requests.length = 0;
    const request = new Request("https://shiba.test/api/runs", {
      headers: { [LOCAL_INTAKE_HEADER]: "forged" },
    });
    const response = await handleRuns(request, env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests[0]?.headers.get(LOCAL_INTAKE_HEADER)).toBe("dashboard");
  });

  it("routes GET /api/spine through the same lane with the principal strip", async () => {
    forwarded.requests.length = 0;
    const request = new Request("https://shiba.test/api/spine", {
      headers: { [AGENT_PRINCIPAL_HEADER]: "claude-code" },
    });
    const response = await handleRuns(request, env);
    expect(response?.status).toBe(200);
    expect(forwarded.requests).toHaveLength(1);
    // Dashboard-authed callers always get the full view — the filter only
    // applies to internally stamped agent principals, never this lane.
    const proxied = forwarded.requests[0];
    expect(new URL(proxied!.url).pathname).toBe("/api/spine");
    expect(proxied?.headers.get(AGENT_PRINCIPAL_HEADER)).toBeNull();
  });

  it("rejects non-GET methods on /api/spine", async () => {
    const response = await handleRuns(
      new Request("https://shiba.test/api/spine", { method: "POST" }),
      env,
    );
    expect(response?.status).toBe(405);
  });
});
