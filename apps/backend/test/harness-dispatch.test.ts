/**
 * Live harness approvals: the daemon posts with its claim token, the
 * dashboard decides, and the next poll returns that decision.
 */

import { buildLocalRunEnvelope, LOCAL_RUNTIME_FLAG, type LocalRunEnvelope } from "@shiba/shared";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { LocalDispatch } from "../src/local-dispatch.js";
import { DUMMY_PROVIDER_KEY } from "../src/provider-gateway.js";

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
vi.mock("agents/mcp", () => ({
  createMcpHandler: () => ({ fetch: async () => new Response(null), notify: {} }),
}));

function makeFleet() {
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
    LocalDispatch: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => obj.fetch(request) }),
    },
    [LOCAL_RUNTIME_FLAG]: "1",
    LOCAL_ADAPTER_TOKEN: "daemon-secret",
  } as never;
  const call = (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
    worker.fetch(
      new Request(`https://localhost${path}`, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: {
          "content-type": "application/json",
          ...(init.token !== undefined ? { authorization: `Bearer ${init.token}` } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      }),
      env,
    );
  return { call, obj };
}

const ENVELOPE: LocalRunEnvelope = buildLocalRunEnvelope({
  input: {
    sandboxId: "sb-h1",
    repoUrl: "https://github.com/acme/widgets",
    baseBranch: "main",
    task: "Add a greeting",
  },
  harnessName: "claude-code",
  workdir: "/workspace/sb-h1",
  configFiles: [],
  setupCommands: [],
  argv: ["claude", "--print"],
  env: {},
  dummyKey: DUMMY_PROVIDER_KEY,
  execAllowlist: [],
  setupAllowlist: [],
  deadlineAt: Date.now() + 60_000,
  session: { provider: "claude", model: "claude", permissionMode: "approval-required" },
});

describe("harness dispatch", () => {
  it("round-trips an approval and a diff for the claimed run", async () => {
    const { call, obj } = makeFleet();
    expect(
      (
        await obj.fetch(
          new Request("https://local-dispatch/dispatch", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ envelope: ENVELOPE }),
          }),
        )
      ).status,
    ).toBe(200);

    const claim = (await (
      await call("/api/local/claim", { body: { operator: "op@box" }, token: "daemon-secret" })
    ).json()) as {
      claimToken: string;
    };
    const denied = await call("/api/local/events", {
      body: {
        sandboxId: "sb-h1",
        claimToken: "nope",
        event: { type: "message.completed", text: "no" },
      },
      token: "daemon-secret",
    });
    expect(denied.status).toBe(409);

    expect(
      (
        await call("/api/local/events", {
          body: {
            sandboxId: "sb-h1",
            claimToken: claim.claimToken,
            event: {
              type: "diff.updated",
              text: "diff updated",
              patch: "diff --git a/greeting.txt\n+hello\n",
            },
          },
          token: "daemon-secret",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call("/api/local/approval", {
          body: {
            sandboxId: "sb-h1",
            claimToken: claim.claimToken,
            request: {
              requestId: "r1",
              kind: "file_change",
              title: "Write",
              detail: "greeting.txt",
            },
          },
          token: "daemon-secret",
        })
      ).status,
    ).toBe(200);

    const board = (await (await call("/api/computers/harness")).json()) as {
      runs: {
        sandboxId: string;
        diff: string;
        approvals: { requestId: string; decision?: string }[];
      }[];
    };
    expect(board.runs[0]?.sandboxId).toBe("sb-h1");
    expect(board.runs[0]?.diff).toContain("greeting.txt");
    expect(board.runs[0]?.approvals[0]?.decision).toBeUndefined();

    expect(
      (
        await call("/api/computers/harness/decide", {
          body: { sandboxId: "sb-h1", requestId: "r1", decision: "allow" },
        })
      ).status,
    ).toBe(200);
    const polled = (await (
      await call("/api/local/approval", {
        body: { sandboxId: "sb-h1", claimToken: claim.claimToken, requestId: "r1" },
        token: "daemon-secret",
      })
    ).json()) as { decision?: string };
    expect(polled.decision).toBe("allow");

    expect(
      (
        await call("/api/computers/harness/control", {
          body: { sandboxId: "sb-h1", interrupt: true },
        })
      ).status,
    ).toBe(200);
    const control = (await (
      await call("/api/local/control", {
        body: { sandboxId: "sb-h1", claimToken: claim.claimToken },
        token: "daemon-secret",
      })
    ).json()) as { interrupt: boolean };
    expect(control.interrupt).toBe(true);
    const again = (await (
      await call("/api/local/control", {
        body: { sandboxId: "sb-h1", claimToken: claim.claimToken },
        token: "daemon-secret",
      })
    ).json()) as { interrupt: boolean };
    expect(again.interrupt).toBe(false);
  });
});
