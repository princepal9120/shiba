/**
 * The Automations DO stub + durable delivery dedupe, shared by the webhook
 * fan-outs and the cron tick. Extracted from index.ts (PLAN.md §18.0).
 */
import { AUTOMATIONS_DO_NAME } from "./automation-runner.js";
import type { Env } from "./env.js";

export function automationsStub(env: Env) {
  return env.Automations.get(env.Automations.idFromName(AUTOMATIONS_DO_NAME));
}

/** Durable check-and-record for a retried delivery id. True = already seen. */
export async function seenDelivery(env: Env, key: string): Promise<boolean> {
  const response = await automationsStub(env).fetch(
    new Request("https://internal/internal/dedupe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  );
  const body = (await response.json().catch(() => ({}))) as { seen?: boolean };
  return response.ok && body.seen === true;
}
