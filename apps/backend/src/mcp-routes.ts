/**
 * `/mcp` (and `/mcp/*`) → bearer auth before any MCP handling: a missing or
 * invalid token is a plain 401 JSON, never an MCP protocol error — the
 * request never reaches the transport. On success the verified principal
 * rides into the stateless MCP handler as the `x-shiba-principal` header,
 * which the tool registry reads per call. Extracted from index.ts.
 */
import { verifyToken } from "./agent-tokens.js";
import { verifyOAuthAccessToken } from "./oauth-mcp.js";
import type { Env } from "./env.js";
import { createShibaMcpHandler, encodePrincipal, MCP_PRINCIPAL_HEADER } from "./mcp-gateway.js";
import { isMcpPath } from "./request-auth.js";

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("authorization");
  if (auth === null) {
    return null;
  }
  const [scheme, ...rest] = auth.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== "bearer" || rest.length === 0) {
    return null;
  }
  return rest.join(" ");
}

/**
 * `/mcp` (and `/mcp/*`) → bearer auth before any MCP handling: a missing
 * or invalid token is a plain 401 JSON, never an MCP protocol error — the
 * request never reaches the transport. On success the verified principal
 * rides into the stateless MCP handler as the `x-shiba-principal` header,
 * which the tool registry reads per call.
 */
export async function handleMcp(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isMcpPath(url.pathname)) {
    return null;
  }
  // Pre-auth limit: verifyToken is a KV read per request — without this an
  // unauthenticated flood on /mcp is a KV quota-exhaustion vector.
  if (env.MCP_RATE_LIMIT) {
    const { success } = await env.MCP_RATE_LIMIT.limit({
      key: request.headers.get("cf-connecting-ip") ?? "unknown",
    });
    if (!success) {
      return Response.json({ error: "Too many requests." }, { status: 429 });
    }
  }
  const token = bearerToken(request);
  // Static `shb_` agent tokens resolve first (the documented owner path);
  // OAuth `sho_` access tokens resolve to the same TokenRecord shape so the
  // requireScope→handler→audit gate is byte-identical.
  const record = token === null
    ? null
    : (await verifyToken(env, token) ?? (token.startsWith("sho_") ? await verifyOAuthAccessToken(env, token) : null));
  if (!record) {
    // WWW-Authenticate points MCP clients at the protected-resource doc so
    // OAuth-capable clients discover the flow instead of just dying on 401.
    return Response.json(
      { error: "Authentication required." },
      { status: 401, headers: {
        "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource"`,
      } },
    );
  }
  // Any client-supplied copy must go first — only the worker-verified
  // record may reach the MCP handler under this name.
  const headers = new Headers(request.headers);
  headers.delete(MCP_PRINCIPAL_HEADER);
  // encodePrincipal keeps the JSON ByteString-safe — a non-ASCII
  // principal name would otherwise make Headers.set throw and 500 every
  // call for that token.
  headers.set(MCP_PRINCIPAL_HEADER, encodePrincipal(record));
  // Stateless serving: the handler builds a fresh server per request (env
  // is closed over). `route` is an exact-pathname match, so pass this
  // request's own pathname to keep authenticated /mcp/* subpaths served.
  return createShibaMcpHandler(env, url.pathname).fetch(
    new Request(request, { headers }),
  );
}
