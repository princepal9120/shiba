/**
 * `/api/automations` + automation webhook paths → the Automations DO.
 * Extracted from index.ts.
 */
import { automationsStub } from "./automations-stub.js";
import type { Env } from "./env.js";
import { isAutomationWebhookPath } from "./request-auth.js";

export async function handleAutomations(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/automations" || isAutomationWebhookPath(url.pathname)
    || /^\/api\/automations\/[^/]+\/run\/?$/.test(url.pathname)) {
    return automationsStub(env).fetch(request);
  }
  return null;
}
