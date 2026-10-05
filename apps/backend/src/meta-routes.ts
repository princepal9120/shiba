/**
 * Small dashboard metadata routes: `/api/whoami`, `/api/setup/status`,
 * `/api/agents` (CLI catalog + token principals), `/api/email/openapi.json`.
 * Extracted from index.ts.
 */
import { listTokens } from "./agent-tokens.js";
import emailOpenApi from "./email-openapi.json";
import type { Env } from "./env.js";
import { agentCliCatalog } from "./harness/catalog.js";
import { isBetterAuthConfigured } from "./better-auth.js";
import { modelConfigStub } from "./model-config-do.js";
import { EMPTY_POLICY, PURPOSES } from "./model-connections.js";
import { isAccessConfigured, resolveUserId } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";
import { readSetupStatus } from "./setup-status.js";

/**
 * Registered MCP-token principals for `GET /api/agents` — one row per
 * principal name, aggregated across that name's token records. `live`
 * means at least one non-revoked token exists, i.e. the principal can
 * authenticate at `/mcp` right now (the only connection state the
 * worker can observe for request-scoped MCP traffic). `listTokens`
 * fails closed to [] when the KV binding is absent, so the route
 * degrades to the CLI catalog alone.
 */
async function agentPrincipals(env: Env) {
  const byPrincipal = new Map<
    string,
    { principal: string; scopes: string[]; created: number; live: boolean }
  >();
  for (const record of await listTokens(env)) {
    const entry = byPrincipal.get(record.principal) ?? {
      principal: record.principal,
      scopes: [],
      created: record.created,
      live: false,
    };
    entry.created = Math.min(entry.created, record.created);
    for (const scope of record.scopes) {
      if (!entry.scopes.includes(scope)) entry.scopes.push(scope);
    }
    entry.live = entry.live || !record.revoked;
    byPrincipal.set(record.principal, entry);
  }
  return [...byPrincipal.values()].sort((a, b) => a.created - b.created);
}

export async function handleMeta(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/whoami") {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    // `auth` tells the dashboard which lane proved this identity so it can
    // offer the matching affordances (e.g. sign-out only for better-auth).
    const auth = isAccessConfigured(env)
      ? "access"
      : isBetterAuthConfigured(env)
        ? "better-auth"
        : "none";
    return Response.json(
      { agent: (await resolveUserId(request, env)) ?? "default", auth },
      {
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
  if (url.pathname === "/api/email/openapi.json") {
    if (request.method !== "GET") return methodNotAllowed();
    return Response.json(emailOpenApi, { headers: { "Cache-Control": "no-store" } });
  }
  if (url.pathname === "/api/setup/status") {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    return Response.json(await readSetupStatus(env), {
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (url.pathname === "/api/agents") {
    if (request.method !== "GET") {
      return Response.json({ error: "Method not allowed." }, { status: 405 });
    }
    return Response.json(
      { agents: agentCliCatalog(env), principals: await agentPrincipals(env) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  // The ModelConfig DO, surfaced to the dashboard: `/api/model-config`
  // returns the combined view (connections + purpose policy + the purpose
  // vocabulary); `/api/model-config/…` proxies the DO verbatim so the UI
  // can register connections and edit policy. The identity gate upstream
  // is the only auth — registration rejects pasted secrets server-side.
  if (url.pathname === "/api/model-config" || url.pathname.startsWith("/api/model-config/")) {
    const stub = modelConfigStub(env);
    if (url.pathname === "/api/model-config") {
      if (request.method !== "GET") {
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      const [connectionsRes, policyRes] = await Promise.all([
        stub.fetch(new Request("https://internal/connections")),
        stub.fetch(new Request("https://internal/policy")),
      ]);
      const connections = (await connectionsRes.json().catch(() => ({}))) as { connections?: unknown };
      const policy = (await policyRes.json().catch(() => ({}))) as { policy?: unknown };
      return Response.json(
        {
          connections: connections.connections ?? [],
          policy: policy.policy ?? EMPTY_POLICY,
          purposes: PURPOSES,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    const inner = url.pathname.slice("/api/model-config".length);
    return stub.fetch(new Request(`https://internal${inner}${url.search}`, request));
  }
  return null;
}
