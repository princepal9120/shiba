/**
 * Container egress handlers. They run in the Worker, not the container, so
 * credentials are attached here and never reach repository processes.
 *
 * Kept out of sandbox.ts: that module imports the Sandbox SDK, which pulls
 * `cloudflare:` builtins and cannot be loaded by the node test runner.
 */
import type { Env as WorkerEnv } from "./env.js";
import { sanitizeContainerHeaders, stripCredentialParams } from "./provider-gateway.js";
import { parseCodexAuthJson } from "@shiba/shared";

export type EgressEnv = Pick<
  WorkerEnv,
  "AI" | "GATEWAY_ID" | "AI_GATEWAY_TOKEN" | "GITHUB_TOKEN" | "DEVIN_API_KEY" | "CLAUDE_SUBSCRIPTION_TOKEN" | "CODEX_SUBSCRIPTION_AUTH_JSON" | "CURSOR_SUBSCRIPTION_TOKEN" | "DEVIN_SUBSCRIPTION_TOKEN"
>;

/**
 * Handler ctx carries the per-run params passed to `setOutboundByHost`. The
 * SDK types `params` as `unknown`, so the shape is narrowed at the use site.
 */
export interface OutboundHandlerCtx {
  params?: unknown;
}

function approvedPath(ctx?: OutboundHandlerCtx): string | undefined {
  const params = ctx?.params;
  if (typeof params !== "object" || params === null) return undefined;
  const value = (params as { allowedPath?: unknown }).allowedPath;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function outboundHeaders(request: Request): Headers {
  const headers = sanitizeContainerHeaders(request.headers);
  // Gateway controls and credentials must not be chosen by repository code.
  for (const name of [...headers.keys()]) {
    if (name.startsWith("cf-aig-")) headers.delete(name);
  }
  headers.delete("host");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return headers;
}

/**
 * The AI Gateway provider slug behind each API host. Adding a harness (T22)
 * means adding an entry here, not a new mechanism.
 */
export const GATEWAY_PROVIDERS: Record<string, string> = {
  "generativelanguage.googleapis.com": "google-ai-studio",
  "api.anthropic.com": "anthropic",
  "api.openai.com": "openai",
  "api.x.ai": "grok",
  // OpenCode Go rides the gateway as a configured custom provider slug
  // (spec MODEL-CONNECTIONS-ARCHITECTURE.md §3). The slug names the gateway
  // custom provider holding the Go API key as BYOK.
  "opencode.ai": "opencode-go",
};

async function forwardProvider(request: Request, env: EgressEnv, host: string): Promise<Response> {
  const source = new URL(request.url);
  if (source.protocol !== "https:" || source.hostname !== host) {
    return new Response("Invalid provider destination.", { status: 403 });
  }
  if (request.method !== "POST" && request.method !== "GET") {
    return new Response("Method not allowed.", { status: 405 });
  }
  const slug = GATEWAY_PROVIDERS[host];
  if (!slug) {
    return new Response("Invalid provider destination.", { status: 403 });
  }
  try {
    // getUrl resolves the account from the binding; no account-id var or public callback.
    const base = await env.AI.gateway(env.GATEWAY_ID || "default").getUrl(slug);
    const target = new URL(base);
    target.pathname = `${target.pathname.replace(/\/+$/, "")}${source.pathname}`;
    target.search = stripCredentialParams(source.search);
    const headers = outboundHeaders(request);
    if (env.AI_GATEWAY_TOKEN) headers.set("cf-aig-authorization", `Bearer ${env.AI_GATEWAY_TOKEN}`);
    // The gateway injects its stored BYOK credential; preserve the native body/stream.
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never return or log them.
    return new Response("Provider gateway request failed.", { status: 502 });
  }
}

export function forwardGoogle(request: Request, env: EgressEnv): Promise<Response> {
  return forwardProvider(request, env, "generativelanguage.googleapis.com");
}

export function forwardAnthropic(request: Request, env: EgressEnv): Promise<Response> {
  return forwardProvider(request, env, "api.anthropic.com");
}

export function forwardOpenAI(request: Request, env: EgressEnv): Promise<Response> {
  return forwardProvider(request, env, "api.openai.com");
}

export function forwardXAI(request: Request, env: EgressEnv): Promise<Response> {
  return forwardProvider(request, env, "api.x.ai");
}

/**
 * OpenCode Go (spec §5.6): pinned to the canonical opencode.ai origin and
 * forwarded through the gateway's opencode-go custom provider, which holds
 * the issued API key as BYOK. The container's dummy key and any
 * container-supplied gateway controls are stripped by outboundHeaders; a
 * stable per-run session id rides through untouched.
 */
export function forwardOpenCodeGo(request: Request, env: EgressEnv): Promise<Response> {
  return forwardProvider(request, env, "opencode.ai");
}

/**
 * T48 — the claude-subscription egress branch. The container holds only a
 * placeholder credentials.json; the real `claude setup-token` bearer is
 * attached here — `Authorization: Bearer <token>` plus the oauth beta
 * header the subscription surface requires. Deliberately NOT a
 * GATEWAY_PROVIDERS entry: subscription hosts ride this branch, never the
 * gateway's BYOK path. Deny-by-default: wrong host/protocol → 403, no
 * secret → 503 (fail closed, never silently forward).
 */
export async function forwardClaudeSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const secretName =
    account === "default"
      ? "CLAUDE_SUBSCRIPTION_TOKEN"
      : `CLAUDE_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
  const token = (env as Record<string, unknown>)[secretName];
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    (target.hostname !== "api.anthropic.com" && target.hostname !== "claude.ai") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (typeof token !== "string" || token.trim() === "") {
    return new Response(`${secretName} is not configured on this deployment.`, { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${token}`);
  // The subscription surface requires the oauth beta; container-supplied
  // copies are already stripped by outboundHeaders, so set it here.
  headers.set("anthropic-beta", "oauth-2025-04-20");
  headers.set("anthropic-version", "2023-06-01");
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never surface them.
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/**
 * T49 — the codex-subscription egress branch. The container's CODEX_HOME
 * holds a stub auth.json (placeholder access token + account id); the real
 * `codex login` credential is stored Worker-side as the
 * `CODEX_SUBSCRIPTION_AUTH_JSON` secret — the auth.json CONTENTS — and
 * materialized here: the forwarder rewrites the Bearer and pins the
 * `chatgpt-account-id` header on chatgpt.com's backend API.
 * Deliberately NOT a GATEWAY_PROVIDERS entry: this path never rides the
 * gateway's BYOK route. Deny-by-default: wrong host/protocol → 403, no
 * usable secret → 503 (fail closed).
 */
export async function forwardCodexSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const secretName =
    account === "default"
      ? "CODEX_SUBSCRIPTION_AUTH_JSON"
      : `CODEX_SUBSCRIPTION_AUTH_JSON_${account.toUpperCase().replace(/-/g, "_")}`;
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    target.hostname !== "chatgpt.com" ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  const raw = (env as Record<string, unknown>)[secretName];
  if (typeof raw !== "string" || raw.trim() === "") {
    return new Response(`${secretName} is not configured on this deployment.`, { status: 503 });
  }
  const credential = parseCodexAuthJson(raw);
  if (credential === null) {
    return new Response(`${secretName} is not a valid codex auth.json — re-store the full file contents.`, { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  if (credential.accountId !== null) {
    headers.set("chatgpt-account-id", credential.accountId);
  }
  headers.set("OpenAI-Beta", "responses=experimental");
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never surface them.
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/**
 * The stored-secret parser moved to @shiba/shared (codex-home.ts) so
 * packages/auth can validate a provisioned auth.json without reaching
 * back into the app. Re-exported: callers keep `../egress.js` imports.
 */
export { parseCodexAuthJson } from "@shiba/shared";

/**
 * The cursor-subscription egress branch. The container holds only a dummy
 * CURSOR_API_KEY; the real Cursor Agent API key is attached here as
 * `Authorization: Bearer <token>` — the scheme Cursor's own API surface
 * documents (the Cloud Agents API accepts Basic or Bearer; the CLI's
 * Connect RPCs authenticate the same way). Deny-by-default on the two
 * hosts the CLI calls — api2.cursor.sh (API plane) and repo2.cursor.sh
 * (repo/context backend): wrong host/protocol → 403, no secret → 503
 * (fail closed, never silently forward).
 */
export async function forwardCursorSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const secretName =
    account === "default"
      ? "CURSOR_SUBSCRIPTION_TOKEN"
      : `CURSOR_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
  const token = (env as Record<string, unknown>)[secretName];
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    (target.hostname !== "api2.cursor.sh" && target.hostname !== "repo2.cursor.sh") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (typeof token !== "string" || token.trim() === "") {
    return new Response(`${secretName} is not configured on this deployment.`, { status: 503 });
  }
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  headers.set("Authorization", `Bearer ${token}`);
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "POST" ? request.body : undefined,
      redirect: "manual",
    });
  } catch {
    // Fetch errors can embed authenticated request details; never surface them.
    return new Response("Subscription request failed.", { status: 502 });
  }
}

/**
 * Devin CLI is not an AI Gateway provider — it authenticates to Cognition's
 * own backends with an account API key. The container holds a dummy key in
 * credentials.toml; here the real DEVIN_API_KEY replaces whatever
 * Authorization header repository code sent, exactly like the GitHub
 * forwarder. Wire capture (WINDSURF_API_SERVER_URL against a local echo
 * server) shows the CLI sends `Authorization: Basic <key>-<key>` — key
 * doubled — on every Connect RPC, so mirror that scheme exactly.
 */
async function forwardDevin(request: Request, env: EgressEnv, host: string, apiKey = env.DEVIN_API_KEY): Promise<Response> {
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== host) {
    return new Response("Invalid Devin destination.", { status: 403 });
  }
  target.username = "";
  target.password = "";
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  if (apiKey) {
    // Verified per-host: api.devin.ai/v3/* takes Bearer (Basic -> 403), while
    // server.codeium.com Connect RPCs take the CLI's own `Basic <key>-<key>`
    // form.
    headers.set(
      "Authorization",
      host === "api.devin.ai"
        ? `Bearer ${apiKey}`
        : `Basic ${apiKey}-${apiKey}`,
    );
  }
  let body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  if (body && apiKey && host === "server.codeium.com") {
    body = rewriteDevinBody(body, apiKey, headers.get("content-type") ?? "");
  }
  if (body) headers.delete("content-length");
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    if (response.status >= 400) {
      const upstream = await response.clone().text();
      console.warn(
        `devin egress ${request.method} ${target.pathname} -> ${response.status} ` +
          `key=${apiKey ? "set" : "missing"} sentAuth=${headers.get("authorization") ? "yes" : "no"} ` +
          `body=${upstream.slice(0, 300)}`,
      );
    }
    return response;
  } catch {
    return new Response("Devin request failed.", { status: 502 });
  }
}

const DEVIN_DUMMY_KEY = "dummy-egress-swapped";

/**
 * Unary Connect bodies are raw protobuf; streaming bodies (`connect+proto`)
 * are [1 flag][4 byte big-endian len][message] frames. Rewrite the embedded
 * key inside each frame and fix the frame length.
 */
function rewriteDevinBody(body: ArrayBuffer, apiKey: string, contentType: string): ArrayBuffer {
  if (!contentType.includes("connect+")) return rewriteDevinKey(body, apiKey);
  const bytes = new Uint8Array(body);
  const view = new DataView(body);
  const out: number[] = [];
  let i = 0;
  while (i + 5 <= bytes.length) {
    const frameLen = view.getUint32(i + 1);
    if (i + 5 + frameLen > bytes.length) break; // truncated tail: pass through raw
    const frame = bytes.subarray(i + 5, i + 5 + frameLen);
    const fixed = new Uint8Array(rewriteDevinKey(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frameLen) as ArrayBuffer, apiKey));
    out.push(bytes[i]!, (fixed.length >> 24) & 0xff, (fixed.length >> 16) & 0xff, (fixed.length >> 8) & 0xff, fixed.length & 0xff);
    for (const b of fixed) out.push(b);
    i += 5 + frameLen;
  }
  for (; i < bytes.length; i++) out.push(bytes[i]!);
  return new Uint8Array(out).buffer;
}

/**
 * The CLI also embeds windsurf_api_key inside every Connect-RPC protobuf body
 * (the server checks it there — a wrong body value answers 401
 * "invalid api key"). The key field can sit inside nested messages, so a flat
 * byte-replace corrupts every enclosing LEN prefix. Walk the wire format
 * instead: replace the placeholder string, then re-emit every ancestor
 * length varint.
 */
function encodeVarint(len: number): number[] {
  const out: number[] = [];
  do {
    let b = len & 0x7f;
    len >>= 7;
    if (len) b |= 0x80;
    out.push(b);
  } while (len);
  return out;
}

function readVarint(bytes: Uint8Array, i: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  while (i < bytes.length && shift < 35) {
    const b = bytes[i++]!;
    value += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7;
  }
  return undefined;
}

function rewriteDevinKey(body: ArrayBuffer, apiKey: string): ArrayBuffer {
  const enc = new TextEncoder();
  const dummy = enc.encode(DEVIN_DUMMY_KEY);
  // The CLI embeds the credential both bare and in its doubled `key-key`
  // Basic-auth form; the longer match must win.
  const dummyDouble = enc.encode(`${DEVIN_DUMMY_KEY}-${DEVIN_DUMMY_KEY}`);
  const real = enc.encode(apiKey);
  const realDouble = enc.encode(`${apiKey}-${apiKey}`);
  const contains = (buf: Uint8Array, needle: Uint8Array): boolean => {
    outer: for (let i = 0; i + needle.length <= buf.length; i++) {
      for (let j = 0; j < needle.length; j++) if (buf[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  };
  const is = (buf: Uint8Array, v: Uint8Array) =>
    buf.length === v.length && buf.every((b, j) => b === v[j]);
  // Returns the re-encoded message, or undefined when no placeholder lived
  // inside it. Throws when `buf` is not well-formed protobuf.
  const rewriteMessage = (buf: Uint8Array): Uint8Array | undefined => {
    const parts: number[][] = [];
    let changed = false;
    let i = 0;
    while (i < buf.length) {
      const tagStart = i;
      const tag = readVarint(buf, i);
      if (!tag) throw new Error("tag");
      const wt = tag.value & 7;
      i = tag.next;
      if (wt === 2) {
        const len = readVarint(buf, i);
        if (!len || len.next + len.value > buf.length) throw new Error("len");
        const value = buf.subarray(len.next, len.next + len.value);
        let emitted = value;
        if (is(value, dummy)) {
          emitted = real;
          changed = true;
        } else if (is(value, dummyDouble)) {
          emitted = realDouble;
          changed = true;
        } else if (contains(value, dummy)) {
          try {
            const nested = rewriteMessage(value);
            if (nested) {
              emitted = nested;
              changed = true;
            }
          } catch {
            // A wt-2 value that mentions the placeholder but does not parse
            // as a message is raw string data — leave it untouched.
          }
        }
        parts.push(
          Array.from(buf.subarray(tagStart, tag.next)),
          encodeVarint(emitted.length),
          Array.from(emitted),
        );
        i = len.next + len.value;
      } else if (wt === 0) {
        const v = readVarint(buf, i);
        if (!v) throw new Error("varint");
        i = v.next;
        parts.push(Array.from(buf.subarray(tagStart, i)));
      } else if (wt === 5 || wt === 1) {
        const w = wt === 5 ? 4 : 8;
        if (i + w > buf.length) throw new Error("fixed");
        i += w;
        parts.push(Array.from(buf.subarray(tagStart, i)));
      } else {
        throw new Error("wt");
      }
    }
    if (!changed) return undefined;
    return Uint8Array.from(parts.flat());
  };
  try {
    const out = rewriteMessage(new Uint8Array(body));
    return out ? (out.buffer as ArrayBuffer) : body;
  } catch {
    return body;
  }
}

/** api.devin.ai — Devin control plane (sessions, billing, org). */
export function forwardDevinApi(request: Request, env: EgressEnv): Promise<Response> {
  return forwardDevin(request, env, "api.devin.ai");
}

/** server.codeium.com — inference backend Devin Pro accounts talk to. */
export function forwardDevinInference(request: Request, env: EgressEnv): Promise<Response> {
  return forwardDevin(request, env, "server.codeium.com");
}

/**
 * The devin-subscription egress branch: same wire as forwardDevinApi /
 * forwardDevinInference, but the credential is the operator's
 * DEVIN_SUBSCRIPTION_TOKEN[_<ACCOUNT>] rather than the deployment-wide
 * DEVIN_API_KEY — per-host auth schemes are unchanged (Bearer on
 * api.devin.ai, `Basic <key>-<key>` on server.codeium.com, protobuf body
 * rewrite). Deny-by-default like every subscription branch: wrong
 * host/protocol or userinfo → 403, non-GET/POST → 405, no secret → 503.
 */
export async function forwardDevinSubscription(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const params = (ctx?.params ?? {}) as Record<string, unknown>;
  const account = typeof params.account === "string" && params.account !== "" ? params.account : "default";
  const secretName =
    account === "default"
      ? "DEVIN_SUBSCRIPTION_TOKEN"
      : `DEVIN_SUBSCRIPTION_TOKEN_${account.toUpperCase().replace(/-/g, "_")}`;
  const token = (env as Record<string, unknown>)[secretName];
  const target = new URL(request.url);
  if (
    target.protocol !== "https:" ||
    (target.hostname !== "api.devin.ai" && target.hostname !== "server.codeium.com") ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return new Response("Invalid subscription destination.", { status: 403 });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed.", { status: 405 });
  }
  if (typeof token !== "string" || token.trim() === "") {
    return new Response(`${secretName} is not configured on this deployment.`, { status: 503 });
  }
  return forwardDevin(request, env, target.hostname, token);
}

async function forwardGitHub(request: Request, env: EgressEnv): Promise<Response> {
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== "github.com") {
    return new Response("Invalid repository destination.", { status: 403 });
  }
  target.username = "";
  target.password = "";
  target.search = stripCredentialParams(target.search);
  const headers = outboundHeaders(request);
  if (env.GITHUB_TOKEN) {
    headers.set("Authorization", `Basic ${btoa(`x-access-token:${env.GITHUB_TOKEN}`)}`);
  }
  const ce = headers.get("content-encoding") ?? "<none>";
  const gp = headers.get("git-protocol") ?? "<none>";
  // Buffer the request body so upstream sees a Content-Length, not chunked
  // transfer-encoding (smart-HTTP and Connect-RPC servers reject chunked
  // POSTs). Bodies on these paths are small: git-upload-pack wants, RPC calls.
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  if (body) headers.delete("content-length");
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
    });
    if (response.status >= 400) {
      console.warn(`github egress ${request.method} ${target.pathname} -> ${response.status} ce=${ce} gp=${gp}`);
    }
    return response;
  } catch {
    return new Response("Repository request failed.", { status: 502 });
  }
}

/**
 * True only for the approved repo itself, not a sibling that shares its prefix:
 * `/o/repo-evil` must not match `/o/repo`. GitHub paths are case-insensitive.
 */
export function isWithinRepoScope(pathname: string, allowedPath: string): boolean {
  const path = pathname.toLowerCase();
  const scope = allowedPath.toLowerCase();
  if (!scope.startsWith("/") || scope === "/") return false;
  if (path === scope || path === `${scope}.git`) return true;
  return path.startsWith(`${scope}/`) || path.startsWith(`${scope}.git/`);
}

/**
 * The container only ever fetches. Pushing is a Worker-side REST concern, so
 * a run that tries to push with the injected credential is refused here rather
 * than trusted to behave.
 */
export function isAllowedGitHubRequest(method: string, pathname: string): boolean {
  const verb = method.toUpperCase();
  if (verb === "GET" || verb === "HEAD") return true;
  if (verb !== "POST") return false;
  return pathname.toLowerCase().endsWith("/git-upload-pack");
}

/**
 * B6: the credential is scoped to the one repo this run was approved for, so
 * repository code cannot reach every other repo the token can.
 */
export async function forwardGitHubScoped(
  request: Request,
  env: EgressEnv,
  ctx?: OutboundHandlerCtx,
): Promise<Response> {
  const allowedPath = approvedPath(ctx);
  if (!allowedPath) {
    return new Response("Repository scope was never approved for this run.", { status: 403 });
  }
  const target = new URL(request.url);
  if (target.protocol !== "https:" || target.hostname !== "github.com") {
    return new Response("Invalid repository destination.", { status: 403 });
  }
  if (!isWithinRepoScope(target.pathname, allowedPath)) {
    return new Response("Repository outside the approved scope.", { status: 403 });
  }
  if (!isAllowedGitHubRequest(request.method, target.pathname)) {
    return new Response("Only read-only repository traffic is allowed for this run.", { status: 403 });
  }
  return forwardGitHub(request, env);
}

/** No run has claimed a repo yet, so no credential may leave. */
export function denyUnscopedGitHub(): Promise<Response> {
  return Promise.resolve(
    new Response("Repository scope was never approved for this run.", { status: 403 }),
  );
}
