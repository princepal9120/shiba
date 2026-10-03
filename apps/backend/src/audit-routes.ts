import { listAuditEntries } from "./audit.js";
import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { clampedLimit, MAX_LIST_LIMIT, methodNotAllowed } from "./route-utils.js";
import { redactSecrets } from "./security.js";

/**
 * `GET /api/audit` — the dashboard's read on the D1 audit log (megaplan
 * T13), same Access gate as `/api/runs`. Rows come back newest-first;
 * `?principal=` narrows to one agent, `?limit=` clamps at 200. The
 * `args_hash` column is a SHA-256 fingerprint — never the args — so it
 * is safe to return verbatim.
 */
export async function handleAudit(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/audit") {
    return null;
  }
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET") {
    return methodNotAllowed();
  }
  if (env.AGENT_AUDIT === undefined) {
    return Response.json({ error: "Audit log is not provisioned yet." }, { status: 503 });
  }
  const limit = clampedLimit(url.searchParams.get("limit"), MAX_LIST_LIMIT);
  const principal = url.searchParams.get("principal")?.trim();
  try {
    const entries = await listAuditEntries(env, {
      limit,
      ...(principal ? { principal } : {}),
    });
    return Response.json({ entries }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // The placeholder-id binding throws until `wrangler d1 create` runs —
    // the same 503 the mailbox/memory routes answer while unprovisioned.
    console.warn(
      `audit read failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return Response.json({ error: "Audit log is unavailable." }, { status: 503 });
  }
}
