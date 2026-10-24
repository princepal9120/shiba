/**
 * Per-user OAuth for Providers (Antigravity, Cursor, xAI) — single-writer refresh.
 */
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env.js";
import {
  beginAntigravityOAuth,
  exchangeAntigravityCode,
  parseAntigravityCallbackCode,
  refreshAntigravityToken,
} from "./provider-oauth/antigravity.js";
import { resolveAntigravityOAuthClient } from "./provider-oauth/antigravity-client.js";
import { beginCursorOAuth, pollCursorOnce, refreshCursorToken } from "./provider-oauth/cursor.js";
import {
  beginXaiOAuth,
  discoverXaiEndpoints,
  exchangeXaiCode,
  parseXaiCallbackCode,
  refreshXaiToken,
} from "./provider-oauth/xai.js";
import type { PendingCursorSignIn, PendingPkceSignIn, UserOAuthProvider } from "./provider-oauth/types.js";
import {
  deleteUserOAuthRecord,
  loadUserOAuthRecord,
  openOAuthPendingField,
  saveUserOAuthRecord,
  sealOAuthPendingField,
} from "./user-provider-oauth-store.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";
import { redactSecrets } from "./security.js";

const PENDING_TTL_MS = 15 * 60_000;

function pendingKey(provider: UserOAuthProvider): string {
  return `pending:${provider}`;
}

function xaiTokenEndpointKey(): string {
  return "xai:token-endpoint";
}

export function userProviderOAuthStub(
  env: Pick<Env, "UserProviderOAuth">,
  userId: string,
): DurableObjectStub {
  if (!env.UserProviderOAuth) throw new Error("UserProviderOAuth binding is not configured.");
  const ns = env.UserProviderOAuth;
  return ns.get(ns.idFromName(userId));
}

export class UserProviderOAuth extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const provider = url.searchParams.get("provider") as UserOAuthProvider | null;
    try {
      if (!modelCredentialKeyConfigured(this.env)) {
        return Response.json({ connected: false, error: "Per-user OAuth storage is not configured." }, { status: 503 });
      }
      if (url.pathname === "/status" && request.method === "GET") {
        if (!provider) return Response.json({ error: "provider required" }, { status: 400 });
        return Response.json(await this.status(provider));
      }
      if (url.pathname === "/access" && request.method === "GET") {
        if (!provider) return Response.json({ error: "provider required" }, { status: 400 });
        const record = await this.ensureFresh(provider);
        return Response.json({
          accessToken: record.accessToken,
          expiresAt: record.expiresAt,
          projectId: record.projectId ?? null,
        });
      }
      if (url.pathname === "/begin" && request.method === "POST") {
        if (!provider) return Response.json({ error: "provider required" }, { status: 400 });
        return await this.begin(provider);
      }
      if (url.pathname === "/complete" && request.method === "POST") {
        if (!provider) return Response.json({ error: "provider required" }, { status: 400 });
        const body = (await request.json().catch(() => ({}))) as { callbackUrl?: unknown };
        const callbackUrl = typeof body.callbackUrl === "string" ? body.callbackUrl : "";
        return await this.complete(provider, callbackUrl);
      }
      if (url.pathname === "/logout" && request.method === "DELETE") {
        if (!provider) return Response.json({ error: "provider required" }, { status: 400 });
        await deleteUserOAuthRecord(this.env, this.userId(), provider);
        await this.ctx.storage.delete(pendingKey(provider));
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider OAuth failed.";
      console.error("UserProviderOAuth", redactSecrets(message));
      return Response.json({ error: "Sign-in could not be completed. Start again." }, { status: 400 });
    }
  }

  private userId(): string {
    return this.ctx.id.name ?? "default";
  }

  private async status(provider: UserOAuthProvider): Promise<{ connected: boolean; expiresAt?: number }> {
    const record = await loadUserOAuthRecord(this.env, this.userId(), provider);
    if (!record) return { connected: false };
    return { connected: true, expiresAt: record.expiresAt };
  }

  private async begin(provider: UserOAuthProvider): Promise<Response> {
    const userId = this.userId();
    if (provider === "antigravity") {
      const client = resolveAntigravityOAuthClient(this.env);
      const flow = await beginAntigravityOAuth(client);
      const pending: PendingPkceSignIn = {
        state: flow.state,
        codeVerifierCipher: await sealOAuthPendingField(this.env, userId, provider, "code-verifier", flow.codeVerifier),
        redirectUri: flow.redirectUri,
        createdAt: Date.now(),
      };
      await this.ctx.storage.put(pendingKey(provider), pending);
      return Response.json({
        verificationUri: flow.authorizeUrl,
        signInKind: "antigravity-pkce",
        oauthState: flow.state,
        redirectUri: flow.redirectUri,
      });
    }
    if (provider === "cursor") {
      const flow = await beginCursorOAuth();
      const pending: PendingCursorSignIn = {
        uuid: flow.uuid,
        verifierCipher: await sealOAuthPendingField(this.env, userId, provider, "verifier", flow.verifier),
        createdAt: Date.now(),
      };
      await this.ctx.storage.put(pendingKey(provider), pending);
      return Response.json({
        verificationUri: flow.loginUrl,
        signInKind: "cursor-pkce",
      });
    }
    if (provider === "xai") {
      const flow = await beginXaiOAuth();
      const pending: PendingPkceSignIn = {
        state: flow.state,
        codeVerifierCipher: await sealOAuthPendingField(this.env, userId, provider, "code-verifier", flow.codeVerifier),
        redirectUri: flow.redirectUri,
        createdAt: Date.now(),
        nonce: flow.nonce,
      };
      await this.ctx.storage.put(pendingKey(provider), pending);
      await this.ctx.storage.put(xaiTokenEndpointKey(), flow.tokenEndpoint);
      return Response.json({
        verificationUri: flow.authorizeUrl,
        signInKind: "xai-pkce",
        oauthState: flow.state,
        redirectUri: flow.redirectUri,
      });
    }
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }

  private async complete(provider: UserOAuthProvider, callbackUrl: string): Promise<Response> {
    const pendingRaw = await this.ctx.storage.get<PendingPkceSignIn | PendingCursorSignIn>(pendingKey(provider));
    if (!pendingRaw || Date.now() - pendingRaw.createdAt > PENDING_TTL_MS) {
      return Response.json({ error: "No active sign-in. Start again.", pending: true }, { status: 400 });
    }
    const userId = this.userId();

    if (provider === "cursor") {
      const pending = pendingRaw as PendingCursorSignIn;
      const verifier = await openOAuthPendingField(this.env, userId, provider, "verifier", pending.verifierCipher);
      const poll = await pollCursorOnce(pending.uuid, verifier);
      if (poll.status === "pending") {
        return Response.json({
          pending: true,
          message: "Still waiting for Cursor approval in the browser. Finish sign-in again in a few seconds.",
        });
      }
      await saveUserOAuthRecord(this.env, userId, provider, poll.record);
      await this.ctx.storage.delete(pendingKey(provider));
      return Response.json({
        connected: true,
        message: "Cursor account connected. Tokens stay encrypted and attach at egress.",
      });
    }

    const pending = pendingRaw as PendingPkceSignIn;
    if (!callbackUrl.trim()) {
      return Response.json({
        pending: true,
        message: "Paste the http://127.0.0.1 redirect URL from the browser, then Finish sign-in again.",
      });
    }

    const codeVerifier = await openOAuthPendingField(
      this.env,
      userId,
      provider,
      "code-verifier",
      pending.codeVerifierCipher,
    );

    let record;
    if (provider === "antigravity") {
      const client = resolveAntigravityOAuthClient(this.env);
      const code = parseAntigravityCallbackCode(callbackUrl, pending.state);
      record = await exchangeAntigravityCode(client, code, codeVerifier);
    } else if (provider === "xai") {
      const tokenEndpoint =
        (await this.ctx.storage.get<string>(xaiTokenEndpointKey())) ?? (await discoverXaiEndpoints()).tokenEndpoint;
      const code = parseXaiCallbackCode(callbackUrl, pending.state);
      record = await exchangeXaiCode(code, codeVerifier, tokenEndpoint, pending.nonce);
      await this.ctx.storage.put(xaiTokenEndpointKey(), tokenEndpoint);
    } else {
      return Response.json({ error: "Unknown provider." }, { status: 400 });
    }

    await saveUserOAuthRecord(this.env, userId, provider, record);
    await this.ctx.storage.delete(pendingKey(provider));
    const label =
      provider === "antigravity"
        ? "Gemini (Antigravity) connected."
        : provider === "xai"
          ? "Grok account connected."
          : "Provider connected.";
    return Response.json({
      connected: true,
      message: `${label} Tokens stay encrypted for this user and attach at egress.`,
    });
  }

  private async ensureFresh(provider: UserOAuthProvider) {
    const record = await loadUserOAuthRecord(this.env, this.userId(), provider);
    if (!record) throw new Error("Not connected.");
    if (record.expiresAt > Date.now() + 60_000) return record;
    let refreshed;
    if (provider === "antigravity") {
      const client = resolveAntigravityOAuthClient(this.env);
      refreshed = await refreshAntigravityToken(client, record.refreshToken);
    } else if (provider === "cursor") {
      refreshed = await refreshCursorToken(record.refreshToken);
    } else {
      const tokenEndpoint =
        (await this.ctx.storage.get<string>(xaiTokenEndpointKey())) ?? (await discoverXaiEndpoints()).tokenEndpoint;
      refreshed = await refreshXaiToken(record.refreshToken, tokenEndpoint);
      await this.ctx.storage.put(xaiTokenEndpointKey(), tokenEndpoint);
    }
    const merged = { ...refreshed, projectId: refreshed.projectId ?? record.projectId };
    await saveUserOAuthRecord(this.env, this.userId(), provider, merged);
    return merged;
  }
}
