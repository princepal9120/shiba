/**
 * Shared route helpers for the per-surface handler modules — extracted
 * from index.ts (PLAN.md §18.0). A JSON object body or a 400; the list
 * limit clamp every read surface shares.
 */
import { InputError } from "./security.js";

export const MAX_LIST_LIMIT = 200;

export function clampedLimit(raw: string | null, fallback: number): number {
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIST_LIMIT) : fallback;
}

export function methodNotAllowed(): Response {
  return Response.json({ error: "Method not allowed." }, { status: 405 });
}

/** Same contract as the DO `jsonBody` — a JSON object or a 400. */
export async function jsonObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new InputError("Request body is not valid JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new InputError("Request body must be a JSON object.");
  }
  return body as Record<string, unknown>;
}
