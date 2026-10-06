import { describe, expect, it } from "vitest";
import { AGENT_PRINCIPAL_HEADER, LOCAL_INTAKE_HEADER } from "@shiba/shared";
import {
  carriesVouchedHeaders,
  INTERNAL_SIGNATURE_HEADER,
  INTERNAL_TIMESTAMP_HEADER,
  signInternalRequest,
  verifyInternalRequest,
} from "../src/edge-identity.js";

const KEYED = { INTERNAL_SIGNING_KEY: "test-signing-secret-0123456789" };
const UNKEYED = {} as { INTERNAL_SIGNING_KEY?: string };

function vouchedRequest(init?: { principal?: string | null; intake?: string | null }): Request {
  const req = new Request("https://internal/api/runs?session=web:u:1", { method: "POST" });
  if (init?.principal !== null && init?.principal !== undefined) {
    req.headers.set(AGENT_PRINCIPAL_HEADER, init.principal);
  }
  if (init?.intake !== null && init?.intake !== undefined) {
    req.headers.set(LOCAL_INTAKE_HEADER, init.intake);
  }
  return req;
}

describe("edge identity signing", () => {
  it("is a no-op when INTERNAL_SIGNING_KEY is unset", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    await signInternalRequest(req, UNKEYED);
    expect(req.headers.get(INTERNAL_SIGNATURE_HEADER)).toBeNull();
    expect(req.headers.get(INTERNAL_TIMESTAMP_HEADER)).toBeNull();
    const result = await verifyInternalRequest(req, UNKEYED);
    expect(result).toEqual({ ok: true, signed: false });
  });

  it("signs and verifies a vouched request end to end", async () => {
    const req = vouchedRequest({ principal: "agent-1", intake: "dashboard" });
    await signInternalRequest(req, KEYED);
    expect(req.headers.get(INTERNAL_SIGNATURE_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    const result = await verifyInternalRequest(req, KEYED);
    expect(result).toEqual({ ok: true, signed: true });
  });

  it("passes requests without vouched headers unverified even when keyed", async () => {
    const req = new Request("https://internal/internal/sweep-drafts", { method: "POST" });
    const result = await verifyInternalRequest(req, KEYED);
    expect(result).toEqual({ ok: true, signed: false });
    expect(carriesVouchedHeaders(req)).toBe(false);
  });

  it("fails closed on a missing signature when keyed and vouched", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    const result = await verifyInternalRequest(req, KEYED);
    expect(result).toEqual({ ok: false, reason: "missing_signature" });
  });

  it("rejects a tampered principal (canonical fields are bound)", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    await signInternalRequest(req, KEYED);
    req.headers.set(AGENT_PRINCIPAL_HEADER, "agent-2");
    const result = await verifyInternalRequest(req, KEYED);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered path", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    await signInternalRequest(req, KEYED);
    const replayed = new Request("https://internal/api/runs/delete", {
      method: "POST",
      headers: req.headers,
    });
    replayed.headers.set(AGENT_PRINCIPAL_HEADER, "agent-1");
    const result = await verifyInternalRequest(replayed, KEYED);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature from a different key", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    await signInternalRequest(req, { INTERNAL_SIGNING_KEY: "other-key" });
    const result = await verifyInternalRequest(req, KEYED);
    expect(result).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a stale timestamp beyond the 60s skew", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    await signInternalRequest(req, KEYED);
    const ts = req.headers.get(INTERNAL_TIMESTAMP_HEADER);
    const result = await verifyInternalRequest(req, KEYED, Number(ts) + 61_000);
    expect(result).toEqual({ ok: false, reason: "stale_signature" });
  });

  it("rejects a malformed signature", async () => {
    const req = vouchedRequest({ principal: "agent-1" });
    await signInternalRequest(req, KEYED);
    req.headers.set(INTERNAL_SIGNATURE_HEADER, "nothex");
    const result = await verifyInternalRequest(req, KEYED);
    expect(result).toEqual({ ok: false, reason: "malformed_signature" });
  });
});
