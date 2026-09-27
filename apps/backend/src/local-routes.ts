/**
 * `/api/local*` — the T51 operator daemon's self-authenticated surface:
 * the bearer check gates every verb before a byte reaches the dispatch DO.
 * NOT in SIGNATURE_AUTHENTICATED because it self-authenticates. Extracted
 * from index.ts.
 *   POST /api/local/claim    {operator?} → oldest pending envelope + claimToken
 *   POST /api/local/result   {sandboxId, claimToken, result} → settle
 *   GET  /api/local/status?sandboxId=    → record status + result
 *   GET  /api/local/pending              → pending/claimed inventory
 * The Worker-side dispatch/cancel go through the DO stub directly — no
 * HTTP surface exists for minting work, only for claiming it.
 */
import { LOCAL_ADAPTER_TOKEN_ENV, LOCAL_RUNTIME_FLAG } from "@shiba/shared";
import type { Env } from "./env.js";
import { localDispatchStub } from "./local-dispatch.js";
import { timingSafeEqualString } from "./security.js";

export function isLocalRuntimePath(pathname: string): boolean {
  return pathname === "/api/local" || pathname.startsWith("/api/local/");
}

export async function handleLocalAdapter(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sub = url.pathname.slice("/api/local".length).replace(/^\/+|\/+$/g, "");
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const expected = env[LOCAL_ADAPTER_TOKEN_ENV]?.trim();
  if (expected === undefined || expected === "") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  const presented = request.headers.get("authorization") ?? "";
  if (!timingSafeEqualString(presented, `Bearer ${expected}`)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  const stub = localDispatchStub(env);
  const target = new URL(`https://local-dispatch/${sub}${url.search}`);
  if (sub !== "claim" && sub !== "result" && sub !== "status" && sub !== "pending") {
    return Response.json({ error: "Not found." }, { status: 404 });
  }
  return stub.fetch(new Request(target, request));
}
