/**
 * T52 Remote Access fleet: heartbeat upsert, stale → offline, prune,
 * single-use + TTL-bound pairing, and revoke → the machine's next call 401s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_COMPUTER_PRUNE_MS,
  LOCAL_HEARTBEAT_STALE_MS,
  LOCAL_PAIRING_TTL_MS,
  LOCAL_RUNTIME_FLAG,
  type ConnectedComputer,
  type PairingTokenResponse,
} from "@shiba/shared";
import worker from "../src/index.js";
import { LocalDispatch } from "../src/local-dispatch.js";

vi.mock("@cloudflare/sandbox", () => ({
  ContainerProxy: class {},
  Sandbox: class {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ destroy: async () => {} }),
}));
vi.mock("agents/routing", () => ({ getAgentByName: vi.fn(), routeAgentRequest: async () => null }));
vi.mock("@cloudflare/think", () => ({ Think: class {} }));
vi.mock("agents/agent-tools", () => ({ agentTool: () => ({ execute: vi.fn() }) }));
vi.mock("../src/agents/opencode-agent.js", () => ({ OpenCodeAgent: class {} }));
vi.mock("agents/mcp", () => ({ createMcpHandler: () => ({ fetch: async () => new Response(null), notify: {} }) }));

function makeFleet(extraEnv: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>();
  const storage = {
    get: async <T>(key: string) => map.get(key) as T | undefined,
    put: async (key: string, value: unknown) => void map.set(key, value),
    delete: async (key: string) => void map.delete(key),
    list: async <T>(opts: { prefix: string }) =>
      new Map([...map.entries()].filter(([key]) => key.startsWith(opts.prefix))) as Map<string, T>,
  };
  const obj = new LocalDispatch({ storage, waitUntil: () => {} } as never, {} as never);
  const env = {
    CodingOrchestrator: {} as never,
    LocalDispatch: { idFromName: (name: string) => name, get: () => ({ fetch: (r: Request) => obj.fetch(r) }) },
    [LOCAL_RUNTIME_FLAG]: "1",
    PAIRING_SECRET: "pairing-secret",
    ...extraEnv,
  } as never;
  const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    worker.fetch(
      new Request(`https://localhost${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json", ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
      env,
    );
  const computers = async () => ((await (await call("/api/computers")).json()) as { computers: ConnectedComputer[] }).computers;
  return { call, computers, map };
}

const MACHINE = { hostname: "box", platform: "darwin-arm64", daemonVersion: "0.1.0", harnesses: ["claude", "codex"] };

async function pair(fleet: ReturnType<typeof makeFleet>) {
  const minted = (await (await fleet.call("/api/computers/pairing-token", { method: "POST" })).json()) as PairingTokenResponse;
  const res = await fleet.call("/api/local/pair", { body: { pairingToken: minted.token, ...MACHINE } });
  return { minted, res };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1_800_000_000_000);
});
afterEach(() => vi.useRealTimers());

describe("pairing", () => {
  it("mints a copyable connect command and exchanges the token exactly once", async () => {
    const fleet = makeFleet();
    const { minted, res } = await pair(fleet);
    expect(minted.expiresAt).toBe(Date.now() + LOCAL_PAIRING_TTL_MS);
    expect(minted.connectCommand).toContain(`--connect https://localhost --pair ${minted.token}`);
    expect(res.status).toBe(200);
    const { adapterToken, machineId } = (await res.json()) as { adapterToken: string; machineId: string };
    expect(adapterToken).toMatch(/^[0-9a-f]{64}$/);
    // Stored hashed, never raw.
    expect(JSON.stringify([...fleet.map.values()])).not.toContain(adapterToken);
    expect((await fleet.computers()).map((c) => c.machineId)).toEqual([machineId]);
    const replay = await fleet.call("/api/local/pair", { body: { pairingToken: minted.token, ...MACHINE } });
    expect(replay.status).toBe(401);
  });

  it("refuses an expired, tampered, or foreign-secret token", async () => {
    const fleet = makeFleet();
    const minted = (await (await fleet.call("/api/computers/pairing-token", { method: "POST" })).json()) as PairingTokenResponse;
    const [payload, sig] = minted.token.split(".");
    const tampered = `${payload}.${sig!.slice(0, -2)}AA`;
    expect((await fleet.call("/api/local/pair", { body: { pairingToken: tampered, ...MACHINE } })).status).toBe(401);
    const other = makeFleet({ PAIRING_SECRET: "other" });
    expect((await other.call("/api/local/pair", { body: { pairingToken: minted.token, ...MACHINE } })).status).toBe(401);
    vi.setSystemTime(Date.now() + LOCAL_PAIRING_TTL_MS + 1);
    expect((await fleet.call("/api/local/pair", { body: { pairingToken: minted.token, ...MACHINE } })).status).toBe(401);
  });

  it("400s a malformed pair body", async () => {
    const fleet = makeFleet();
    expect((await fleet.call("/api/local/pair", { body: { pairingToken: "x" } })).status).toBe(400);
  });
});

describe("heartbeat + fleet status", () => {
  it("upserts, reads busy/idle, goes offline past the stale window, and prunes after 7d", async () => {
    const fleet = makeFleet();
    const { adapterToken, machineId } = (await (await pair(fleet)).res.json()) as { adapterToken: string; machineId: string };
    const beat = (extra: Record<string, unknown> = {}) =>
      fleet.call("/api/local/heartbeat", { token: adapterToken, body: { machineId, ...MACHINE, ...extra } });
    expect((await beat({ activeRunId: "sb-1", hostname: "renamed" })).status).toBe(200);
    let [computer] = await fleet.computers();
    expect(computer).toMatchObject({ hostname: "renamed", status: "busy", activeRunId: "sb-1", harnesses: ["claude", "codex"] });
    expect(computer!.pairedAt).toBeDefined();
    expect(computer).not.toHaveProperty("tokenHash");
    await beat();
    [computer] = await fleet.computers();
    expect(computer!.status).toBe("idle");
    vi.setSystemTime(Date.now() + LOCAL_HEARTBEAT_STALE_MS + 1);
    [computer] = await fleet.computers();
    expect(computer!.status).toBe("offline");
    vi.setSystemTime(Date.now() + LOCAL_COMPUTER_PRUNE_MS);
    expect(await fleet.computers()).toEqual([]);
  });

  it("a per-machine token speaks only for its own machine; bad shapes 400", async () => {
    const fleet = makeFleet();
    const { adapterToken } = (await (await pair(fleet)).res.json()) as { adapterToken: string };
    const spoof = await fleet.call("/api/local/heartbeat", { token: adapterToken, body: { machineId: "someone-else", ...MACHINE } });
    expect(spoof.status).toBe(403);
    const bad = await fleet.call("/api/local/heartbeat", { token: adapterToken, body: { machineId: 7 } });
    expect(bad.status).toBe(400);
  });

  it("env-var mode (LOCAL_ADAPTER_TOKEN) keeps working without pairing", async () => {
    const fleet = makeFleet({ PAIRING_SECRET: undefined, LOCAL_ADAPTER_TOKEN: "daemon-secret" });
    const res = await fleet.call("/api/local/heartbeat", { token: "daemon-secret", body: { machineId: "m-env", ...MACHINE } });
    expect(res.status).toBe(200);
    expect((await fleet.computers())[0]).toMatchObject({ machineId: "m-env", status: "idle" });
    expect((await fleet.call("/api/local/claim", { token: "daemon-secret", body: {} })).status).toBe(200);
  });
});

describe("revoke", () => {
  it("removes the machine and its next heartbeat and claim 401", async () => {
    const fleet = makeFleet();
    const { adapterToken, machineId } = (await (await pair(fleet)).res.json()) as { adapterToken: string; machineId: string };
    expect((await fleet.call("/api/local/claim", { token: adapterToken, body: {} })).status).toBe(200);
    expect((await fleet.call("/api/computers/revoke", { body: { machineId } })).status).toBe(200);
    expect(await fleet.computers()).toEqual([]);
    expect((await fleet.call("/api/local/heartbeat", { token: adapterToken, body: { machineId, ...MACHINE } })).status).toBe(401);
    expect((await fleet.call("/api/local/claim", { token: adapterToken, body: {} })).status).toBe(401);
  });
});

describe("dark by default", () => {
  it("/api/computers and /api/local/pair 404 with the flag off", async () => {
    const fleet = makeFleet({ [LOCAL_RUNTIME_FLAG]: undefined });
    expect((await fleet.call("/api/computers")).status).toBe(404);
    expect((await fleet.call("/api/computers/pairing-token", { method: "POST" })).status).toBe(404);
    expect((await fleet.call("/api/local/pair", { body: { pairingToken: "x", ...MACHINE } })).status).toBe(404);
  });
});
