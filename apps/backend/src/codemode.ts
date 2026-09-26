/**
 * Code Mode (Cloudflare pattern, blog.cloudflare.com/code-mode): instead of
 * letting the planning agent call gateway tools one JSON-RPC at a time, it
 * writes JavaScript against a `codemode.*` TypeScript API generated from the
 * SAME ToolRegistry the /mcp endpoint serves — one `run_code` tool whose
 * generated code executes in a fresh isolate per call (WorkerLoader), with
 * no network: `globalOutbound: null` means fetch()/connect() throw, and the
 * only way out is the RPC dispatcher back into this worker.
 *
 * Auth is inherited, never minted: generated code calls tools as
 * {@link ORCHESTRATOR_PRINCIPAL}, so the registry's requireScope + args_hash
 * audit row fire exactly as they would for an external MCP client. The
 * human-approval contract is untouched — delegate_coding_task stays a
 * direct `needsApproval` tool (codemode would run it instantly), and the
 * email/run mutation tools only ever *queue* approvals.
 */
import { createCodeTool } from "@cloudflare/codemode/ai";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { SCOPES, type Scope, type TokenRecord } from "./agent-tokens.js";
import type { Env } from "./env.js";
import { createToolRegistry, type ToolRegistry } from "./mcp-gateway.js";
import { registerEmailTools } from "./mcp-email-tools.js";
import { registerMemoryTools } from "./mcp-memory-tools.js";
import { registerRunTools } from "./mcp-run-tools.js";

/** Everything an agentic caller may do; admin:tokens stays operator-only. */
const ORCHESTRATOR_SCOPES: Scope[] = SCOPES.filter((s) => s !== "admin:tokens");

export const ORCHESTRATOR_PRINCIPAL: TokenRecord = {
  principal: "orchestrator-agent",
  scopes: ORCHESTRATOR_SCOPES,
  created: 0,
  revoked: false,
};

function resultText(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === "text" ? part.text : JSON.stringify(part)))
    .join("\n");
}

/** Adapt each registered MCP tool into an AI SDK tool the executor can RPC to. */
export function gatewayToolSet(env: Env, registry: ToolRegistry): ToolSet {
  const set: ToolSet = {};
  for (const t of registry.tools()) {
    set[t.name] = tool({
      description: t.meta.description ?? t.name,
      inputSchema: z.object(t.meta.inputSchema ?? {}),
      execute: async (args) => {
        const result = await registry.invoke(t.name, args, ORCHESTRATOR_PRINCIPAL);
        if (result.isError) throw new Error(resultText(result));
        return resultText(result);
      },
    });
  }
  return set;
}

function buildRegistry(env: Env): ToolRegistry {
  const registry = createToolRegistry(env);
  registerEmailTools(registry, env);
  registerMemoryTools(registry, env);
  registerRunTools(registry, env);
  return registry;
}

/**
 * The single model-facing tool: write an `async () => { ... }` body that
 * calls `codemode.<tool>(args)` and returns/log()s only the fields it needs.
 * Requires the `LOADER` worker_loaders binding in wrangler.jsonc.
 */
export function createRunCodeTool(env: Env) {
  if (!env.LOADER) return null;
  const executor = new DynamicWorkerExecutor({
    loader: env.LOADER,
    globalOutbound: null,
  });
  return createCodeTool({
    tools: [{ name: "codemode", tools: gatewayToolSet(env, buildRegistry(env)) }],
    executor,
    description:
      "Execute JavaScript in an isolated sandbox to use the coworker's tools.\n\nAvailable:\n{{types}}\n\n" +
      "Write an async arrow function (plain JS, no TypeScript syntax) calling " +
      "codemode.<tool>({...}); chain calls, loop, and filter in code — only the " +
      "returned value comes back. Sends and deletes still queue for human " +
      "approval; approving is never possible from code.",
  });
}
