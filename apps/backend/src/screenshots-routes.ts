import type { Env } from "./env.js";
import { isAuthorizedRequest } from "./request-auth.js";
import { isValidSandboxId } from "./sandbox-routes.js";
import { screenshotKeyFor } from "./screenshot.js";

/**
 * T33: stored PR preview screenshots, served from the ATTACHMENTS bucket
 * under `screenshots/{sandboxId}.png`. Same gate as every other read API —
 * the link in a published PR body resolves only for authenticated viewers.
 */
export async function handleScreenshot(request: Request, env: Env): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const match = /^\/api\/screenshots\/([^/]+)$/.exec(pathname);
  if (!match) return null;
  if (!(await isAuthorizedRequest(request, env))) {
    return Response.json({ error: "Authentication required." }, { status: 401 });
  }
  if (request.method !== "GET") {
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  }
  let sandboxId: string;
  try {
    sandboxId = decodeURIComponent(match[1]!);
  } catch {
    return Response.json({ error: "Invalid sandbox ID encoding." }, { status: 400 });
  }
  if (!isValidSandboxId(sandboxId)) {
    return Response.json({ error: "Invalid sandbox ID format." }, { status: 400 });
  }
  const object = await env.ATTACHMENTS.get(screenshotKeyFor(sandboxId));
  if (!object) {
    return Response.json({ error: "Screenshot not found." }, { status: 404 });
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": "image/png",
      "Content-Disposition": "inline",
      "Content-Length": String(object.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
