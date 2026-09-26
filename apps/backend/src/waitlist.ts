import type { Env } from "./env.js";

export type WaitlistInterest = "early-access" | "contribute" | "both" | "pro-plan" | "team-plan";
export interface WaitlistEntry {
  email: string;
  interest: WaitlistInterest;
  github: string | null;
}

const MAX_BODY_BYTES = 4096;
const EMAIL = /^[a-z\d.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?)+$/i;
const GITHUB = /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i;

export function parseWaitlistEntry(value: unknown): WaitlistEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.consent !== true || typeof body.email !== "string" || typeof body.interest !== "string") return null;
  const email = body.email.trim().toLowerCase();
  const github = typeof body.github === "string" ? body.github.trim().replace(/^@/, "") : "";
  if (email.length > 254 || !EMAIL.test(email)) return null;
  const validInterests = ["early-access", "contribute", "both", "pro-plan", "team-plan"];
  if (!validInterests.includes(body.interest)) return null;
  if (github.length > 39 || (github !== "" && !GITHUB.test(github))) return null;
  return { email, interest: body.interest as WaitlistInterest, github: github || null };
}

async function limitedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (contentLength > MAX_BODY_BYTES) throw new Error("too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export async function handleWaitlist(request: Request, env: Pick<Env, "Waitlist">): Promise<Response | null> {
  const url = new URL(request.url);
  const admin = url.pathname === "/api/admin/waitlist";
  if (url.pathname !== "/api/waitlist" && !admin) return null;
  if (env.Waitlist === undefined) return noStore(Response.json({ error: "Waitlist is not configured." }, { status: 503 }));
  const stub = env.Waitlist.get(env.Waitlist.idFromName("signups"));

  if (admin) {
    if (request.method !== "GET" && request.method !== "DELETE") {
      return noStore(Response.json({ error: "Method not allowed." }, { status: 405 }));
    }
    const response = await stub.fetch(new Request(`https://internal/internal/waitlist${url.search}`, request));
    return noStore(response);
  }

  if (request.method !== "POST") return noStore(Response.json({ error: "Method not allowed." }, { status: 405 }));
  if (request.headers.get("Origin") !== url.origin) {
    return noStore(Response.json({ error: "Submit the form from this site." }, { status: 403 }));
  }
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) {
    return noStore(Response.json({ error: "Expected JSON." }, { status: 415 }));
  }
  let body: unknown;
  try {
    body = await limitedJson(request);
  } catch {
    return noStore(Response.json({ error: "Invalid or oversized request." }, { status: 400 }));
  }
  if (body && typeof body === "object" && (body as { company?: unknown }).company) {
    return noStore(Response.json({ error: "Invalid submission." }, { status: 400 }));
  }
  const entry = parseWaitlistEntry(body);
  if (!entry) return noStore(Response.json({ error: "Enter a valid email, interest and consent." }, { status: 400 }));
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const ipHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const response = await stub.fetch(new Request("https://internal/internal/waitlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...entry, ipHash }),
  }));
  return noStore(response);
}
