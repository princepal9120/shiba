import { afterEach, describe, expect, it, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { ACCESS_EMAIL_HEADER, verifyAccessJwt, withVerifiedAccessIdentity } from "../src/access-jwt.js";

const AUD = "aud-tag-123";

async function signer(team: string) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    return new Response("unexpected fetch", { status: 500 });
  });
  return (claims: Record<string, unknown>, aud = AUD, iss = `https://${team}.cloudflareaccess.com`) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(iss)
      .setAudience(aud)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
}

afterEach(() => vi.unstubAllGlobals());

describe("Access JWT verification", () => {
  it("accepts a token for our aud and returns its email", async () => {
    const sign = await signer("team-a");
    expect(await verifyAccessJwt(await sign({ email: "owner@example.com" }), AUD)).toBe("owner@example.com");
  });

  it("rejects a wrong aud, a non-Cloudflare issuer, garbage, and a missing email", async () => {
    const sign = await signer("team-b");
    expect(await verifyAccessJwt(await sign({ email: "x@example.com" }, "other-aud"), AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({ email: "x@example.com" }, AUD, "https://evil.example.com"), AUD)).toBeNull();
    expect(await verifyAccessJwt("not.a.jwt", AUD)).toBeNull();
    expect(await verifyAccessJwt(await sign({}), AUD)).toBeNull();
  });

  it("strips a forged email header and sets the verified one", async () => {
    const sign = await signer("team-c");
    const forged = new Request("https://w/api/runs", { headers: { [ACCESS_EMAIL_HEADER]: "attacker@evil.test" } });
    expect((await withVerifiedAccessIdentity(forged, { ACCESS_AUD: AUD })).headers.get(ACCESS_EMAIL_HEADER)).toBeNull();
    const token = await sign({ email: "owner@example.com" });
    const real = new Request("https://w/api/runs", {
      headers: { [ACCESS_EMAIL_HEADER]: "attacker@evil.test", "Cf-Access-Jwt-Assertion": token },
    });
    expect((await withVerifiedAccessIdentity(real, { ACCESS_AUD: AUD })).headers.get(ACCESS_EMAIL_HEADER)).toBe("owner@example.com");
  });
});
