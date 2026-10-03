/**
 * `/api/memory/*` — cross-agent reads through the shared "global" Memory DO
 * registry stub (T8 contract: a JSON fetch API mirroring mailbox); 503 until
 * that binding ships. Extracted from index.ts.
 */
import type { Env } from "./env.js";
import { memoryRegistryStub } from "./memory-do.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { methodNotAllowed } from "./route-utils.js";

const MEMORY_DO_BASE = "https://internal/internal/memory";

export async function handleMemory(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const { pathname } = url;
  const factId = /^\/api\/memory\/facts\/([^/]+)$/.exec(pathname)?.[1];
  if (pathname !== "/api/memory/facts" && pathname !== "/api/memory/sessions" && factId === undefined) {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (env.Memory === undefined) {
    return Response.json(
      { error: "Memory is not provisioned yet." },
      { status: 503 },
    );
  }
  // Cross-agent reads route through the shared registry stub (T8).
  const stub = memoryRegistryStub(env);
  if (factId !== undefined) {
    if (request.method !== "DELETE") return methodNotAllowed();
    // `pathname` is still percent-encoded — forward the segment verbatim:
    // the DO decodes once, so re-encoding here double-encodes caller ids
    // that legitimately contain escapable characters (`bank` allows them).
    return stub.fetch(`${MEMORY_DO_BASE}/facts/${factId}`, {
      method: "DELETE",
    });
  }
  if (request.method !== "GET") return methodNotAllowed();
  const query = new URLSearchParams();
  for (const key of ["agent", "limit"] as const) {
    const value = url.searchParams.get(key);
    if (value !== null && value !== "") {
      query.set(key, value);
    }
  }
  if (pathname === "/api/memory/sessions") {
    return stub.fetch(`${MEMORY_DO_BASE}/sessions?${query.toString()}`);
  }
  // ?q= switches the route from a plain fact listing to recall (T9 contract:
  // hits ranked by score); the Memory DO mirrors mailbox's /emails/search.
  const q = url.searchParams.get("q")?.trim() ?? "";
  const path = q === "" ? `${MEMORY_DO_BASE}/facts` : `${MEMORY_DO_BASE}/facts/search`;
  if (q !== "") {
    query.set("q", q);
  }
  return stub.fetch(`${path}?${query.toString()}`);
}
