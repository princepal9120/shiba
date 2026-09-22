/**
 * MCP gateway (megaplan task 5): `McpGateway` Durable Object extends
 * `McpAgent` (agents/mcp) and is fronted by the bearer-authed `/mcp` route
 * in index.ts.
 *
 * Auth model: index.ts verifies the bearer token once per HTTP request and
 * forwards the verified {@link TokenRecord} inside the `x-shiba-principal`
 * header (client-supplied copies are stripped first). The MCP transports
 * copy request headers into every tool call's `requestInfo`, so each
 * invocation re-reads that worker-injected record — the per-request context
 * the registry scopes and audits against. DO stubs are unreachable from
 * outside the worker, so the header cannot arrive unverified.
 *
 * Tool calls: `registerTool(name, scope, handler)` stores a handler; every
 * dispatch wraps it in `requireScope` → handler → `audit`. `args_hash` is
 * the SHA-256 of the canonical (sorted-key) JSON args — a hash of the args,
 * never the args themselves, so an audit reader can compare calls without
 * learning what they contained.
 *
 * Note: `McpAgent` is `@deprecated` upstream since agents@0.23.0 (the SDK
 * now recommends `createMcpHandler`); the megaplan Interfaces section
 * mandates it, and the registry seam T6/T9 tools register against is
 * independent of that base class.
 */
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  CallToolResult,
  RequestInfo,
  ServerNotification,
  ServerRequest,
  ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
  requireScope,
  ScopeError,
  sha256Hex,
  type Scope,
  type TokenRecord,
} from "./agent-tokens.js";
import { audit } from "./audit.js";
import { registerEmailTools } from "./mcp-email-tools.js";
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
export function principalFor(request: Request): TokenRecord | null {
  return parsePrincipal(request.headers.get(MCP_PRINCIPAL_HEADER));
}

/** Same lookup against a tool call's `requestInfo` header bag. Exported for tests. */
export function principalFromInfo(info: RequestInfo | undefined): TokenRecord | null {
  const raw = info?.headers?.[MCP_PRINCIPAL_HEADER];
  return parsePrincipal(
    typeof raw === "string" ? raw : Array.isArray(raw) ? (raw[0] ?? null) : null,
  );
}

/**
 * Create the tool registry the gateway serves. Domain modules register
 * their tools here (T6 email, T9 memory) before the DO publishes them.
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

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * The MCP Durable Object. Thin wiring: `init` publishes every registry
 * tool on the SDK server; each callback resolves the injected principal
 * and delegates to the registry's scope/audit wrapper.
 */
export class McpGateway extends McpAgent<Env> {
  server = new McpServer({ name: "shiba-intern", version: "0.1.0" });

  async init(): Promise<void> {
    const registry = createToolRegistry(this.env);
    registerEmailTools(registry, this.env);
    // Later tasks register domain tools here:
    // registerMemoryTools(registry, this.env) (T9).
    for (const tool of registry.tools()) {
      this.server.registerTool(
        tool.name,
        {
          description: tool.meta.description ?? tool.name,
          inputSchema: tool.meta.inputSchema,
          annotations: tool.meta.annotations,
        },
        async (args: Record<string, unknown>, extra: ToolExtra) =>
          registry.invoke(
            tool.name,
            args,
            principalFromInfo(extra.requestInfo),
          ),
      );
    }
  }
}
