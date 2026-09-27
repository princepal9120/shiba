/**
 * Pure security helpers. Dependency-free so they run in the Worker,
 * in Vitest, and anywhere else without modification.
 */

export const GITHUB_HOST = "github.com";
export const MAX_REPO_URL_LENGTH = 2048;

export class InputError extends Error {
  readonly code = "input_error";
  constructor(message: string) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * An input error whose answer is "missing" rather than "malformed" —
 * carries the 404 through DO-to-worker plumbing that otherwise flattens
 * every failure to a 400.
 */
export class NotFoundError extends InputError {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Accept only HTTPS GitHub repository URLs. Anything else throws.
 * Returned names are validated against GitHub's naming rules so they are
 * safe to reuse in API paths and branch names.
 */
export function parseGitHubRepoUrl(raw: string): GitHubRepo {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REPO_URL_LENGTH) {
    throw new InputError("Repository URL must be a non-empty string.");
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InputError("Repository URL is not a valid URL.");
  }
  if (url.protocol !== "https:") {
    throw new InputError("Repository URL must use HTTPS.");
  }
  if (url.hostname.toLowerCase() !== GITHUB_HOST) {
    throw new InputError("Repository URL must point to github.com.");
  }
  if (url.username !== "" || url.password !== "") {
    throw new InputError("Repository URL must not embed credentials.");
  }
  const segments = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (segments.length !== 2) {
    throw new InputError("Repository URL must look like https://github.com/owner/repo.");
  }
  const namePattern = /^[A-Za-z0-9_.-]+$/;
  const owner = segments[0] as string;
  let repo = segments[1] as string;
  if (repo.toLowerCase().endsWith(".git")) {
    repo = repo.slice(0, -4);
  }
  if (owner === "" || repo === "" || owner === "." || owner === ".." || repo === "." || repo === "..") {
    throw new InputError("Repository URL has an invalid owner or repo name.");
  }
  if (!namePattern.test(owner) || !namePattern.test(repo)) {
    throw new InputError("Repository URL has an invalid owner or repo name.");
  }
  return { owner, repo };
}

/**
 * Shell quoting moved to @shiba/shared (security.ts) so packages/auth's
 * antigravity provider builds sandbox commands without app imports.
 */
export { shellJoin, shellQuote } from "@shiba/shared";

/**
 * Deterministic, DNS-safe sandbox name from repo URL, task, and a nonce.
 * Lowercase alphanumerics and hyphens only, capped at 63 characters so the
 * value is safe as a Durable Object id, container label, and directory name.
 */
export function makeSandboxId(repoUrl: string, task: string, nonce: string): string {
  const digest = cyrb53(`${repoUrl}\n${task}\n${nonce}`);
  return `run-${digest}`;
}

/** 53-bit hash rendered as 14 lowercase hex chars. Pure and deterministic. */
export function cyrb53(input: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const upper = (h2 >>> 0).toString(16).padStart(8, "0");
  const lower = (h1 >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  return `${upper}${lower}`.toLowerCase();
}

// The scrubber lives in @shiba/shared so packages/ code can redact too;
// re-exported so existing `./security.js` imports are unchanged.
export { redactSecrets } from "@shiba/shared";

/** Keep the tail of a log bounded, with a marker when truncated. */
export function boundTail(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return `…[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

/**
 * Constant-time string equality — for bearer-token compares where
 * crypto.subtle.timingSafeEqual is not in the runtime's type surface.
 * Lengths are compared first; a length mismatch rejects before the loop
 * so no prefix information leaks.
 */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify a GitHub webhook HMAC-SHA256 signature (`sha256=<hex>`) with a
 * timing-safe comparison. Uses WebCrypto so it runs in Workers and Node.
 */
export async function verifyGitHubWebhookSignature(args: {
  secret: string;
  payload: string;
  signature: string | null;
}): Promise<boolean> {
  const { secret, payload, signature } = args;
  if (!secret || !signature || !signature.startsWith("sha256=")) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const actual = signature.slice("sha256=".length).toLowerCase();
  if (actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}
