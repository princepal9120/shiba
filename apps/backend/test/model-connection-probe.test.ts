import { describe, expect, it, vi } from "vitest";
import { probeModelConnection } from "../src/model-connection-probe.js";
import type { Connection } from "../src/model-connections.js";
import type { Env } from "../src/env.js";

function conn(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_1",
    owner: "deployment",
    service: "anthropic",
    status: "unconfigured",
    authMode: "gateway-byok",
    displayName: "t",
    credentialRef: null,
    createdAt: 0,
    updatedAt: 0,
    lastCheckedAt: null,
    ...overrides,
  };
}

describe("probeModelConnection", () => {
  it("reports missing Worker secrets for service connections", async () => {
    const result = await probeModelConnection({} as Env, conn({ service: "cursor", authMode: "worker-service-secret" }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain("CURSOR_API_KEY");
  });

  it("HEADs the AI Gateway for BYOK services", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const env = {
      AI: { gateway: () => ({ getUrl: async () => "https://gateway.example/anthropic" }) },
      GATEWAY_ID: "default",
    } as unknown as Env;
    const result = await probeModelConnection(env, conn());
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
