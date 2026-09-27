import { describe, expect, it, vi } from "vitest";

// `mcp-gateway.js` pulls agents/mcp at module load; stub the base class —
// the registry seam under test never constructs it.
vi.mock("agents/mcp", () => ({
  McpAgent: class {
    static serve(_path: string, _opts?: unknown) {
      return {
        fetch: async () => Response.json({ mcp: "served" }, { status: 200 }),
      };
    }
  },
}));

import {
  createRunCodeTool,
  gatewayToolSet,
  ORCHESTRATOR_PRINCIPAL,
} from "../src/codemode.js";
import { createToolRegistry } from "../src/mcp-gateway.js";
import { registerEmailTools } from "../src/mcp-email-tools.js";
import { registerMemoryTools } from "../src/mcp-memory-tools.js";
import { registerRunTools } from "../src/mcp-run-tools.js";
import type { Env } from "../src/env.js";
import type { WorkerLoader } from "@cloudflare/workers-types";

const bareEnv = {} as Env;

function registry() {
  const reg = createToolRegistry(bareEnv);
  registerEmailTools(reg, bareEnv);
  registerMemoryTools(reg, bareEnv);
  registerRunTools(reg, bareEnv);
  return reg;
}

describe("ORCHESTRATOR_PRINCIPAL", () => {
  it("carries every scope except admin:tokens", () => {
    expect(ORCHESTRATOR_PRINCIPAL.scopes).not.toContain("admin:tokens");
    expect(ORCHESTRATOR_PRINCIPAL.scopes.length).toBeGreaterThan(0);
  });
});

describe("gatewayToolSet", () => {
  it("adapts every registered tool into an executable AI SDK tool", () => {
    const reg = registry();
    const set = gatewayToolSet(bareEnv, reg);
    const names = reg.tools().map((t) => t.name);
    expect(Object.keys(set).sort()).toEqual(names.sort());
    for (const name of names) {
      expect(set[name]?.inputSchema).toBeDefined();
      expect(set[name]?.description).toBeTruthy();
    }
  });

  it("throws the tool's error text when registry.invoke returns isError", async () => {
    const set = gatewayToolSet(bareEnv, registry());
    // No Mailbox binding in bareEnv: the handler's DO lookup throws, the
    // gateway wraps it as an isError result, and the adapter rethrows it.
    const listMailboxes = set["list_mailboxes"];
    expect(listMailboxes?.execute).toBeDefined();
    const execute = listMailboxes!.execute! as unknown as (
      input: unknown,
    ) => Promise<unknown>;
    await expect(execute({})).rejects.toThrow();
  });
});

describe("createRunCodeTool", () => {
  it("returns null without the LOADER binding", () => {
    expect(createRunCodeTool(bareEnv)).toBeNull();
  });

  it("returns a run_code tool when LOADER is bound", () => {
    const env = { LOADER: {} } as { LOADER?: WorkerLoader } as Env;
    const runCode = createRunCodeTool(env);
    expect(runCode).not.toBeNull();
    expect(runCode?.description).toContain("Execute JavaScript");
  });
});
