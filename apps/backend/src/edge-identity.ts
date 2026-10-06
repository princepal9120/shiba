/**
 * Edge identity signing (PLAN-V2-NEXT edge-identity phase).
 *
 * Vouched headers — X-Agent-Principal and X-Shiba-Intake — carry authority
 * only because the Worker stamps them after authenticating the caller. Today
 * the DO trusts them by construction; with INTERNAL_SIGNING_KEY configured the
 * producer signs and the consumer verifies, so a forged vouched header on any
 * internal path is rejected instead of granting another principal's scope.
 *
 * Rollout: when INTERNAL_SIGNING_KEY is unset the DO keeps the pre-signing
 * behavior (header trust) and logs a once-per-lifetime warning — local dev
 * and unstaged deploys keep working. Set the same secret on the Worker and it
 * signs every vouched call; consumers fail closed on a bad or missing
 * signature for requests that carry vouched headers. Requests without any
 * vouched header pass unverified, matching today's trust level for them.
 */
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";

export const INTERNAL_SIGNATURE_HEADER = "X-Shiba-Internal-Sig";
export const INTERNAL_TIMESTAMP_HEADER = "X-Shiba-Internal-Ts";

const MAX_SKEW_MS = 60_000;

const encoder = new TextEncoder();

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** The fields that make a request "vouched" — what the signature protects. */
export function vouchedValues(request: Request): { principal: string | null; intake: string | null } {
  return {
    principal: request.headers.get(AGENT_PRINCIPAL_HEADER),
    intake: request.headers.get(LOCAL_INTAKE_HEADER),
  };
}

export function carriesVouchedHeaders(request: Request): boolean {
  const { principal, intake } = vouchedValues(request);
  return principal !== null || intake !== null;
}

function canonical(request: Request, timestamp: string): string {
  const url = new URL(request.url);
  const { principal, intake } = vouchedValues(request);
  return [
    request.method.toUpperCase(),
    url.pathname + url.search,
    principal ?? "",
    intake ?? "",
    timestamp,
  ].join("\n");
}

/**
 * Sign a request headed for a DO stub (or another internal consumer). Mutates
 * the request's headers — call after vouched headers are stamped, before
 * `stub.fetch`. No-op when INTERNAL_SIGNING_KEY is unset.
 */
export async function signInternalRequest(request: Request, env: { INTERNAL_SIGNING_KEY?: string }): Promise<void> {
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  if (!secret) return;
  const timestamp = Date.now().toString();
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical(request, timestamp)));
  request.headers.set(INTERNAL_TIMESTAMP_HEADER, timestamp);
  request.headers.set(INTERNAL_SIGNATURE_HEADER, bytesToHex(new Uint8Array(sig)));
}

export type InternalVerification =
  | { ok: true; signed: boolean }
  | { ok: false; reason: string };

/**
 * Verify an inbound internal request. Called by DO consumers that read
 * vouched headers as authority.
 *
 * - Key unset → `signed: false`, ok (fallback trust; caller may warn once).
 * - Key set + no vouched headers → ok, nothing to verify.
 * - Key set + vouched headers → valid signature within skew required; a
 *   missing/late/bad signature fails closed.
 */
export async function verifyInternalRequest(
  request: Request,
  env: { INTERNAL_SIGNING_KEY?: string },
  now = Date.now(),
): Promise<InternalVerification> {
  const secret = env.INTERNAL_SIGNING_KEY?.trim();
  if (!secret) return { ok: true, signed: false };
  if (!carriesVouchedHeaders(request)) return { ok: true, signed: false };

  const timestamp = request.headers.get(INTERNAL_TIMESTAMP_HEADER);
  const signature = request.headers.get(INTERNAL_SIGNATURE_HEADER);
  if (!timestamp || !signature) return { ok: false, reason: "missing_signature" };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale_signature" };
  }
  const sigBytes = hexToBytes(signature);
  if (!sigBytes) return { ok: false, reason: "malformed_signature" };

  const key = await importKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes as BufferSource,
    encoder.encode(canonical(request, timestamp)),
  );
  return valid ? { ok: true, signed: true } : { ok: false, reason: "bad_signature" };
}
