/** PKCE helpers for provider OAuth (S256). */

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomBase64Url(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export async function pkceChallengeS256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = randomBase64Url(32);
  const challenge = await pkceChallengeS256(verifier);
  return { verifier, challenge };
}
