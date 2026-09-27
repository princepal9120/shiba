/**
 * MCP gateway (megaplan task 5, T29a): a stateless MCP server built per
 * request by {@link createShibaMcpHandler} — `createMcpHandler` from
 * `agents/mcp` over an SDK v2 `McpServer` factory. No Durable Object is
 * involved; the `McpAgent` DO base class is deprecated since agents@0.23.0.
 *
 * Auth model: index.ts verifies the bearer token once per HTTP request and
 * forwards the verified {@link TokenRecord} inside the `x-shiba-principal`
 * header (client-supplied copies are stripped first). The handler's serving
 * is per-request and stateless, so the server instance a tool call runs on
 * only ever sees that one request — the callback re-reads the injected
 * header from `ctx.http?.req` (the request the transport dispatched) with
 * the factory's own `requestInfo` as fallback. The header can therefore
 * never arrive unverified: index.ts is the only caller and it always
 * rewrites the header before handing the request over.
 *
 * Tool calls: `registerTool(name, scope, handler)` stores a handler; every
 * dispatch wraps it in `requireScope` → handler → `audit`. `args_hash` is
 * the SHA-256 of the canonical (sorted-key) JSON args — a hash of the args,
 * never the args themselves, so an audit reader can compare calls without
 * learning what they contained.
 */
import { createMcpHandler } from "agents/mcp";
import {
  McpServer,
  type CallToolResult as CallToolResultV2,
  type McpRequestContext,
  type ServerContext,
} from "@modelcontextprotocol/server";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { ZodType } from "zod";
import {
  requireScope,
  ScopeError,
  sha256Hex,
  type Scope,
  type TokenRecord,
} from "./agent-tokens.js";
import { audit } from "./audit.js";
import { registerEmailTools } from "./mcp-email-tools.js";
import { registerMemoryTools } from "./mcp-memory-tools.js";
import { registerRunTools } from "./mcp-run-tools.js";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

/**
 * Worker-injected header carrying the verified TokenRecord JSON. The worker
 * deletes any client copy before setting it, so its presence always means
 * "verified upstream" — never a client claim.
 */
export const MCP_PRINCIPAL_HEADER = "x-shiba-principal";

/**
 * ByteString-safe JSON for the principal header: `Headers.set` rejects
 * values containing chars above Latin-1, so an unescaped non-ASCII
 * principal name (emoji, CJK) would throw at injection time and 500 every
 * `/mcp` call for that token. Escaping each such code unit as `\uXXXX`
 * keeps the header a plain JSON document {@link parsePrincipal} decodes
 * unchanged.
 */
export function encodePrincipal(record: TokenRecord): string {
  return JSON.stringify(record).replace(
    /[\u0100-\uFFFF]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** Narrow env surface — the registry audits against the D1 binding. */
export type McpGatewayEnv = Env;

/** Per-call context a tool handler receives alongside its args. */
export interface ToolCallContext {
  env: McpGatewayEnv;
  /** The verified token record for this request. */
  principal: TokenRecord;
}

export type McpToolHandler = (
  args: Record<string, unknown>,
  ctx: ToolCallContext,
) => CallToolResult | Promise<CallToolResult>;

/** Optional metadata a tool publishes to MCP clients at registration. */
export interface ToolMeta {
  description?: string;
  inputSchema?: ZodRawShapeCompat;
  annotations?: ToolAnnotations;
}

interface RegisteredTool {
  name: string;
  scope: Scope;
  handler: McpToolHandler;
  meta: ToolMeta;
}

export interface ToolRegistry {
  registerTool(
    name: string,
    scope: Scope,
    handler: McpToolHandler,
    meta?: ToolMeta,
  ): void;
  /** Dispatch one call: scope check → handler → audit. Never throws. */
  invoke(
    name: string,
    args: unknown,
    principal: TokenRecord | null,
  ): Promise<CallToolResult>;
  /** Every registered tool, registration order. */
  tools(): RegisteredTool[];
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Sorted-key deep copy so the args hash ignores JSON key order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * SHA-256 of the canonical tool args — the value stored as `args_hash`.
 * It covers the raw args (two calls with identical args hash identically),
 * but the row itself carries only the digest, never the args.
 */
export async function hashToolArgs(args: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(args)));
}

/** Shape-check a JSON payload back into a TokenRecord (deny on any miss). */
function parsePrincipal(raw: string | null): TokenRecord | null {
  if (!raw) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.principal !== "string" ||
    !Array.isArray(record.scopes) ||
    !record.scopes.every((s) => typeof s === "string") ||
    typeof record.created !== "number" ||
    typeof record.revoked !== "boolean"
  ) {
    return null;
  }
  return {
    principal: record.principal,
    scopes: record.scopes as Scope[],
    created: record.created,
    revoked: record.revoked,
  };
}

/**
 * The verified principal attached to a request — reads the worker-injected
 * `x-shiba-principal` header. Returns null when absent or malformed so
 * callers deny instead of guessing. Exported for tests.
 */
export function principalFor(request: Request | null | undefined): TokenRecord | null {
  return parsePrincipal(request?.headers.get(MCP_PRINCIPAL_HEADER) ?? null);
}

/**
 * Create the tool registry the gateway serves. Domain modules register
 * their tools here (T6 email, T9 memory, run tools) before the per-request
 * server publishes them.
 */
export function createToolRegistry(env: McpGatewayEnv): ToolRegistry {
  const tools = new Map<string, RegisteredTool>();
  return {
    registerTool(name, scope, handler, meta = {}) {
      tools.set(name, { name, scope, handler, meta });
    },
    tools() {
      return [...tools.values()];
    },
    async invoke(name, args, principal) {
      const caller = principal?.principal ?? "<unknown>";
      // args_hash is required on every audit row; args that cannot be
      // serialized (BigInt, circular refs) fail the call before a handler
      // or scope check ever runs, still under an `error` row.
      let argsHash: string;
      try {
        argsHash = await hashToolArgs(args);
      } catch (error) {
        const detail = redactSecrets(
          error instanceof Error ? error.message : String(error),
        );
        await audit(env, {
          principal: caller,
          tool: name,
          argsHash: "<unhashable>",
          outcome: "error",
          detail,
        });
        return errorResult(`Tool "${name}" failed: ${detail}`);
      }
      const tool = tools.get(name);
      if (!tool) {
        // An unknown name is still a tool call: audit it so an
        // authenticated principal probing the registry leaves a row.
        await audit(env, {
          principal: caller,
          tool: name,
          argsHash,
          outcome: "error",
          detail: "unknown tool",
        });
        return errorResult(`Unknown tool "${name}".`);
      }
      try {
        requireScope(principal, tool.scope);
        const result = await tool.handler(
          (args ?? {}) as Record<string, unknown>,
          { env, principal: principal as TokenRecord },
        );
        await audit(env, {
          principal: caller,
          tool: name,
          argsHash,
          outcome: "ok",
        });
        return result;
      } catch (error) {
        if (error instanceof ScopeError) {
          await audit(env, {
            principal: caller,
            tool: name,
            argsHash,
            outcome: "denied",
            detail: `missing scope: ${tool.scope}`,
          });
          return errorResult(`Forbidden: missing scope "${tool.scope}".`);
        }
        const detail = redactSecrets(
          error instanceof Error ? error.message : String(error),
        );
        await audit(env, {
          principal: caller,
          tool: name,
          argsHash,
          outcome: "error",
          detail,
        });
        return errorResult(`Tool "${name}" failed: ${detail}`);
      }
    },
  };
}

/**
 * Build the per-request MCP server the stateless handler serves: a fresh
 * `McpServer` (SDK v2) with every registry tool published. The factory runs
 * once per HTTP request, so `mcpCtx.requestInfo` IS the request this
 * instance exists to serve — and each tool callback still re-reads the
 * injected principal from its own dispatch context (`ctx.http?.req`),
 * falling back to that same request.
 */
function buildMcpServer(env: Env, mcpCtx: McpRequestContext): McpServer {
  const server = new McpServer({ name: "shiba", version: "0.1.0" });
  const registry = createToolRegistry(env);
  registerEmailTools(registry, env);
  registerMemoryTools(registry, env);
  registerRunTools(registry, env);
  for (const tool of registry.tools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.meta.description ?? tool.name,
        // SDK v2 types raw shapes as Record<string, z.ZodType>; the
        // registry carries the SDK v1 compat shape (same zod v4 values).
        inputSchema: tool.meta.inputSchema as
          | Record<string, ZodType>
          | undefined,
        annotations: tool.meta.annotations,
      },
      async (args: Record<string, unknown>, ctx: ServerContext) =>
        (await registry.invoke(
          tool.name,
          args,
          principalFor(ctx.http?.req ?? mcpCtx.requestInfo),
        )) as CallToolResultV2,
    );
  }
  return server;
}

/**
 * The `/mcp` route handler. `createMcpHandler` (agents/mcp) wraps the SDK
 * v2 stateless entry: the factory builds a fresh server per request, the
 * legacy (2025-era) lane is served statelessly by the same definition, and
 * CORS/host/origin validation ride along. `route` is an exact-pathname
 * match inside the wrapper, so the caller passes the request's own
 * pathname to keep `/mcp/*` subpaths reachable (index.ts gates them all
 * behind bearer auth first). `env` is closed over per request — stateless
 * serving makes per-request construction the supported shape.
 */
export function createShibaMcpHandler(env: Env, route: string) {
  return createMcpHandler(
    (mcpCtx: McpRequestContext) => buildMcpServer(env, mcpCtx),
    { route },
  );
}
