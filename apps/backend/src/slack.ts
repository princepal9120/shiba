/**
 * Slack request verification. HMAC-SHA256 over `v0:{timestamp}:{body}`
 * with a 5-minute replay window, per
 * https://docs.slack.dev/authentication/verifying-requests-from-slack
 *
 * Uses WebCrypto so it runs in Workers and in Vitest without modification.
 * Mirrors the shape of verifyGitHubWebhookSignature in src/security.ts.
 */

/** Maximum age of a Slack request timestamp, in seconds (5 minutes). */
export const SLACK_REPLAY_WINDOW_SECONDS = 300;

export type SlackHeaders = Headers | Record<string, string | null | undefined>;

function readHeader(headers: SlackHeaders, name: string): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const record = headers as Record<string, string | null | undefined>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === name) {
      return record[key] ?? null;
    }
  }
  return null;
}

/** Constant-time string comparison. Length mismatch returns false. */
export function timingSafeEqual(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verify an inbound Slack request. Returns true only when the `v0=` HMAC
 * signature matches the raw body and the timestamp is within 5 minutes of
 * `now` (defaults to Date.now()). Anything else — missing headers, missing
 * secret, unparseable or stale timestamp, bad signature — returns false.
 */
export async function verifySlackRequest(
  body: string,
  headers: SlackHeaders,
  secret: string,
  now: number = Date.now(),
): Promise<boolean> {
  const timestamp = readHeader(headers, "x-slack-request-timestamp");
  const signature = readHeader(headers, "x-slack-signature");
  if (!timestamp || !signature || !secret) {
    return false;
  }
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  // Bound replay: Slack's own guidance is a 5-minute window.
  if (Math.abs(now / 1000 - timestampSeconds) > SLACK_REPLAY_WINDOW_SECONDS) {
    return false;
  }
  const expected = `v0=${await hmacHex(secret, `v0:${timestamp}:${body}`)}`;
  return timingSafeEqual(signature, expected);
}
