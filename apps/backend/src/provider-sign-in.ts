/**
 * Real provider sign-in for the dashboard cards.
 *
 * Codex uses the ChatGPT device-code grant (the Codex CLI flow). A pasted
 * loopback callback is only the fallback. Tokens stay encrypted in
 * ChatGptAuth; runs attach them at egress.
 *
 * Claude tries a paired local daemon first. Otherwise the card waits for a
 * `claude setup-token` paste, stored encrypted per user. Neither path asks
 * the operator to set a flag.
 */
import type { SubscriptionForwarder } from "@shiba/auth";
import { claudeSubscriptionAuth } from "@shiba/auth";
import { LOCAL_RUNTIME_FLAG, type AcpSignInKind, type ConnectedComputer } from "@shiba/shared";
import { CODEX_DEVICE_VERIFICATION_URL } from "./chatgpt/device-auth.js";
import { mintDaemonPairing } from "./computers-routes.js";
import { type EgressEnv, forwardClaudeSubscription } from "./egress.js";
import type { Env } from "./env.js";
import { chatGptAuthStub } from "./chatgpt-auth-do.js";
import { localDispatchStub } from "./local-dispatch.js";
import { modelCredentialKeyConfigured } from "./subscription-credentials.js";
import { assertPastableSecret, putUserProviderSecret } from "./user-provider-keys.js";
import type { UserOAuthProvider } from "./provider-oauth/types.js";
import { userProviderOAuthStub } from "./user-provider-oauth-do.js";
import { userProviderOAuthReady } from "./user-provider-oauth-store.js";

const SIGN_IN_TTL_MS = 15 * 60 * 1000;
const QUIET_AUTH_PHASES = new Set(["idle", "cleared", "failed"]);

export interface SignInContext {
  mode: "oauth" | "setup-token";
  origin: string;
  now: number;
}

export interface SignInSession {
  ok: boolean;
  pending: boolean;
  message: string;
  userCode?: string;
  verificationUri?: string;
  signInKind?: AcpSignInKind;
  oauthState?: string;
  operatorSteps?: string[];
  expiresAt?: number;
}

export interface SignInVerdict {
  ok: boolean;
  pending?: boolean;
  message: string;
  operatorSteps?: string[];
}

export interface SignInLanes {
  forwardClaude?: SubscriptionForwarder;
}

export const CODEX_OPERATOR_STEPS = [
  "Connect with sign-in. The card shows a code and opens auth.openai.com/codex/device.",
  "Sign in with the ChatGPT account that has Codex and enter that code.",
  "Choose Finish sign-in. The access token stays encrypted for you and is attached when a run calls the provider.",
  "If the device page fails, paste the http://127.0.0.1 callback from a ChatGPT sign-in window instead.",
];

export const CLAUDE_DAEMON_STEPS = [
  "Install Claude Code on your computer and run: claude auth login",
  "Run the pairing command shown on this card.",
  "After that computer reports in, choose Finish sign-in. Run the task with runtime Local and harness Claude Code.",
];

const GEMINI_ANTIGRAVITY_STEPS = [
  "Connect with sign-in. The card opens Google OAuth for Antigravity / Cloud Code Assist.",
  "With pnpm dev or pnpm shiba dev, the loopback listener on 127.0.0.1:51121 completes sign-in automatically.",
  "Otherwise paste the full http://127.0.0.1:51121/callback URL, then choose Finish sign-in.",
];

const GROK_OAUTH_STEPS = [
  "Connect with sign-in. The card opens xAI OAuth for your Grok account.",
  "With pnpm dev or pnpm shiba dev, the loopback listener on 127.0.0.1:56121 completes sign-in automatically.",
  "Otherwise paste the http://127.0.0.1:56121/callback URL, then choose Finish sign-in.",
];

const CURSOR_OAUTH_STEPS = [
  "Connect with sign-in. Approve the login at cursor.com in your browser.",
  "Return here and choose Finish sign-in. The Worker polls Cursor until the account is linked.",
  "Tokens stay encrypted for you and attach at egress for cursor-agent runs.",
];

const CLAUDE_SETUP_STEPS = [
  "On your computer, run: claude setup-token",
  "Paste the token below and choose Finish sign-in.",
  "The token is stored encrypted for you. A run attaches it at egress. The sandbox only sees a placeholder.",
];

function claudeForward(lanes: SignInLanes): SubscriptionForwarder {
  return (
    lanes.forwardClaude ??
    ((request, env, ctx) => forwardClaudeSubscription(request, env as EgressEnv, ctx))
  );
}

function safeMessage(value: unknown, fallback: string): string {
  const message =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
      ? (value as { error: string }).error
      : fallback;
  if (message.length > 300 || /bearer\s+\S{8,}/i.test(message) || message.includes("sk-")) {
    return fallback;
  }
  return message;
}

export function isLoopbackCallback(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

async function listComputers(env: Env): Promise<ConnectedComputer[]> {
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) return [];
  const response = await localDispatchStub(env).fetch(new Request("https://local-dispatch/computers"));
  if (!response.ok) return [];
  const body = (await response.json().catch(() => null)) as { computers?: unknown } | null;
  if (!Array.isArray(body?.computers)) return [];
  return body.computers.filter((row): row is ConnectedComputer => {
    if (typeof row !== "object" || row === null) return false;
    const computer = row as ConnectedComputer;
    return typeof computer.hostname === "string" && Array.isArray(computer.harnesses);
  });
}

function readyClaudeDaemon(computers: readonly ConnectedComputer[]): ConnectedComputer | undefined {
  return computers.find(
    (computer) => computer.status !== "offline" && computer.harnesses.includes("claude"),
  );
}

async function beginCodex(env: Env, org: string, ctx: SignInContext): Promise<SignInSession> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      pending: false,
      signInKind: "chatgpt-device",
      message: "ChatGPT sign-in storage is not ready on this deployment. This card will not invent a confirmation code.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/device/begin", {
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as {
    userCode?: unknown;
    verificationUri?: unknown;
    expiresAt?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    return {
      ok: false,
      pending: false,
      signInKind: "chatgpt-device",
      message: safeMessage(body, "ChatGPT device sign-in could not start."),
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  const userCode = typeof body?.userCode === "string" ? body.userCode : "";
  const verificationUri =
    typeof body?.verificationUri === "string" && body.verificationUri.startsWith("https://auth.openai.com/")
      ? body.verificationUri
      : CODEX_DEVICE_VERIFICATION_URL;
  if (userCode === "") {
    return {
      ok: false,
      pending: false,
      signInKind: "chatgpt-device",
      message: "ChatGPT device sign-in returned no code. Start again.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  return {
    ok: true,
    pending: true,
    signInKind: "chatgpt-device",
    userCode,
    verificationUri,
    expiresAt: typeof body?.expiresAt === "number" ? body.expiresAt : ctx.now + SIGN_IN_TTL_MS,
    message: "Enter this code at auth.openai.com/codex/device, then choose Finish sign-in.",
    operatorSteps: [
      "Open auth.openai.com/codex/device and sign in with the ChatGPT account that has Codex.",
      `Enter the code ${userCode}.`,
      "Choose Finish sign-in. The token stays encrypted for you.",
    ],
  };
}

async function completeDevice(env: Env, org: string): Promise<SignInVerdict> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return { ok: false, message: "ChatGPT sign-in storage is not ready on this deployment.", operatorSteps: CODEX_OPERATOR_STEPS };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/device/finish", {
    method: "POST",
  });
  const body = (await response.json().catch(() => null)) as {
    pending?: unknown;
    message?: unknown;
    error?: unknown;
    connected?: unknown;
  } | null;
  if (body?.pending === true) {
    return {
      ok: false,
      pending: true,
      message:
        typeof body.message === "string"
          ? body.message
          : "Still waiting. Enter the code at auth.openai.com/codex/device, then choose Finish sign-in again.",
    };
  }
  if (!response.ok || body?.connected === false) {
    return {
      ok: false,
      message: safeMessage(body, "ChatGPT device sign-in could not be completed."),
      operatorSteps: CODEX_OPERATOR_STEPS.slice(0, 3),
    };
  }
  return {
    ok: true,
    message:
      typeof body?.message === "string"
        ? body.message
        : "ChatGPT plan connected. The access token stays encrypted for this user and is attached at egress.",
  };
}

async function completeCodex(env: Env, org: string, callbackUrl: string | null): Promise<SignInVerdict> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      message: "ChatGPT sign-in is not configured on this deployment.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  if (callbackUrl === null || !isLoopbackCallback(callbackUrl)) {
    return {
      ok: false,
      message: "Paste the http://127.0.0.1 callback URL from the browser address bar.",
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2, 4),
    };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callbackUrl }),
  });
  const body = (await response.json().catch(() => null)) as {
    error?: unknown;
    connected?: unknown;
    planUsageEnabled?: unknown;
  } | null;
  if (!response.ok) {
    return {
      ok: false,
      message: safeMessage(body, "ChatGPT sign-in could not be completed."),
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2),
    };
  }
  if (body?.planUsageEnabled === false) {
    return {
      ok: false,
      message:
        "Signed in, but ChatGPT plan usage was not granted. Start sign-in again and accept chatgpt.tokens.use.direct, or the run cannot use your subscription.",
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2, 4),
    };
  }
  if (body?.connected === false) {
    return { ok: false, message: "ChatGPT did not confirm the connection. Start sign-in again.", operatorSteps: CODEX_OPERATOR_STEPS.slice(2) };
  }
  return {
    ok: true,
    message:
      "ChatGPT plan connected. Runs use codex-subscription. The access token stays encrypted for this user and is attached at egress.",
  };
}

async function inspectCodex(env: Env, org: string): Promise<SignInVerdict> {
  if (!env.ChatGptAuth || !modelCredentialKeyConfigured(env)) {
    return {
      ok: false,
      message: "ChatGPT plan storage is not configured.",
      operatorSteps: CODEX_OPERATOR_STEPS,
    };
  }
  const response = await chatGptAuthStub(env, org).fetch("https://chatgpt-auth.internal/status");
  if (!response.ok) {
    return { ok: false, message: "ChatGPT plan status could not be read.", operatorSteps: CODEX_OPERATOR_STEPS.slice(0, 2) };
  }
  const body = (await response.json().catch(() => null)) as {
    connected?: unknown;
    planUsageEnabled?: unknown;
  } | null;
  if (body?.connected === true && body.planUsageEnabled !== false) {
    return {
      ok: true,
      message:
        "ChatGPT plan is connected for this user. Egress attaches the access token; the sandbox only sees a placeholder.",
    };
  }
  if (body?.connected === true && body.planUsageEnabled === false) {
    return {
      ok: false,
      message: "ChatGPT is connected but plan usage is disabled. Re-consent from Connect with sign-in.",
      operatorSteps: CODEX_OPERATOR_STEPS.slice(2, 4),
    };
  }
  return {
    ok: false,
    message: "No ChatGPT plan is connected for this user.",
    operatorSteps: CODEX_OPERATOR_STEPS.slice(2),
  };
}

async function beginClaudeDaemon(env: Env, ctx: SignInContext): Promise<SignInSession> {
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-daemon",
      message: "A paired computer is not available from this deployment.",
    };
  }
  const ready = readyClaudeDaemon(await listComputers(env));
  if (ready) {
    return {
      ok: true,
      pending: false,
      signInKind: "claude-daemon",
      message: `Paired daemon ${ready.hostname} has the claude CLI. Run tasks with runtime Local and harness Claude Code. Credentials stay on that machine (claude auth login).`,
      operatorSteps: [
        "On that machine, run claude auth login if you have not already.",
        "In the task composer, set runtime to Local and harness to Claude Code.",
      ],
    };
  }
  const minted = await mintDaemonPairing(env, ctx.origin);
  if (!minted.ok) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-daemon",
      message: "Pairing is not available, so this card will ask for a setup token instead.",
    };
  }
  return {
    ok: true,
    pending: true,
    signInKind: "claude-daemon",
    expiresAt: minted.expiresAt,
    message:
      "No paired computer has reported the claude CLI yet. Run this command on your machine, then claude auth login, then Finish sign-in.",
    operatorSteps: [
      minted.command,
      "claude auth login",
      "Finish sign-in after the daemon heartbeat. Then run the task with runtime Local and harness Claude Code.",
    ],
  };
}

async function completeClaudeDaemon(env: Env): Promise<SignInVerdict> {
  if (env[LOCAL_RUNTIME_FLAG] !== "1" || env.LocalDispatch === undefined) {
    return {
      ok: false,
      message: "The local runtime is not enabled, so Claude sign-in cannot finish.",
      operatorSteps: CLAUDE_DAEMON_STEPS,
    };
  }
  const ready = readyClaudeDaemon(await listComputers(env));
  if (!ready) {
    return {
      ok: false,
      message:
        "No paired machine has reported the claude CLI yet. Install Claude Code, run claude auth login, start the daemon, then Finish sign-in again.",
      operatorSteps: CLAUDE_DAEMON_STEPS.slice(2, 5),
    };
  }
  return {
    ok: true,
    message: `Paired daemon ${ready.hostname} has the claude CLI. Run tasks with runtime Local and harness Claude Code. Shiba does not copy the Claude credential.`,
  };
}

function claudePasteSession(ctx: SignInContext): SignInSession {
  return {
    ok: true,
    pending: true,
    signInKind: "claude-setup-token",
    expiresAt: ctx.now + SIGN_IN_TTL_MS,
    message: "Run claude setup-token on your computer, paste the token, then Finish sign-in.",
    operatorSteps: CLAUDE_SETUP_STEPS,
  };
}

async function storeClaudeSetupToken(env: Env, org: string, credential: string): Promise<SignInVerdict> {
  let secret: string;
  try {
    secret = assertPastableSecret(credential);
  } catch (error) {
    return {
      ok: false,
      pending: true,
      message: error instanceof Error ? error.message : "Paste the token from claude setup-token.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  try {
    await putUserProviderSecret(env, org, "claude-setup", secret);
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "The token could not be stored.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  return {
    ok: true,
    message:
      "Claude setup token stored for this user. Runs attach it at egress. The sandbox only sees a placeholder.",
  };
}

async function beginClaudeSetupToken(env: Env, org: string, lanes: SignInLanes): Promise<SignInSession> {
  if (env.SHIBA_CLAUDE_SUBSCRIPTION !== "1") {
    return claudePasteSession({ mode: "setup-token", origin: "", now: Date.now() });
  }
  const token = env.CLAUDE_SUBSCRIPTION_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    return claudePasteSession({ mode: "setup-token", origin: "", now: Date.now() });
  }
  const controller = claudeSubscriptionAuth(env, "claude-sub:default", claudeForward(lanes));
  const current = await controller.snapshot();
  if (current.phase === "succeeded") {
    return {
      ok: true,
      pending: false,
      signInKind: "claude-setup-token",
      message:
        current.message ??
        "Setup-token lane is already authenticated. The container holds a placeholder.",
    };
  }
  if (!QUIET_AUTH_PHASES.has(current.phase)) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-setup-token",
      message: `Subscription sign-in is ${current.phase}. This page will not interrupt it.`,
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  try {
    await controller.begin(org);
    const snapshot = await controller.verify(org);
    return {
      ok: snapshot.phase === "succeeded",
      pending: false,
      signInKind: "claude-setup-token",
      message: snapshot.message ?? snapshot.phase,
      ...(!snapshot.phase || snapshot.phase !== "succeeded" ? { operatorSteps: CLAUDE_SETUP_STEPS } : {}),
    };
  } catch (error) {
    return {
      ok: false,
      pending: false,
      signInKind: "claude-setup-token",
      message: error instanceof Error ? safeMessage({ error: error.message }, "Setup-token probe failed.") : "Setup-token probe failed.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
}

function userOAuthProvider(providerId: string): UserOAuthProvider | null {
  if (providerId === "gemini") return "antigravity";
  if (providerId === "grok") return "xai";
  if (providerId === "cursor") return "cursor";
  return null;
}

function oauthSteps(provider: UserOAuthProvider): string[] {
  if (provider === "antigravity") return GEMINI_ANTIGRAVITY_STEPS;
  if (provider === "xai") return GROK_OAUTH_STEPS;
  return CURSOR_OAUTH_STEPS;
}

async function beginUserOAuth(env: Env, org: string, provider: UserOAuthProvider): Promise<SignInSession> {
  const steps = oauthSteps(provider);
  if (!userProviderOAuthReady(env)) {
    return {
      ok: false,
      pending: false,
      message: "Per-user OAuth storage is not ready on this deployment (MODEL_CREDENTIAL_KEY + UserProviderOAuth).",
      operatorSteps: steps,
    };
  }
  const response = await userProviderOAuthStub(env, org).fetch(
    `https://user-provider-oauth.internal/begin?provider=${provider}`,
    { method: "POST" },
  );
  const body = (await response.json().catch(() => null)) as {
    verificationUri?: unknown;
    signInKind?: unknown;
    oauthState?: unknown;
    error?: unknown;
  } | null;
  if (!response.ok) {
    return {
      ok: false,
      pending: false,
      message: safeMessage(body, "Sign-in could not start."),
      operatorSteps: steps,
    };
  }
  const verificationUri = typeof body?.verificationUri === "string" ? body.verificationUri : "";
  if (verificationUri === "") {
    return {
      ok: false,
      pending: false,
      message: "Sign-in did not return an authorize URL. Start again.",
      operatorSteps: steps,
    };
  }
  const signInKind =
    typeof body?.signInKind === "string" ? (body.signInKind as SignInSession["signInKind"]) : undefined;
  const oauthState = typeof body?.oauthState === "string" ? body.oauthState : undefined;
  return {
    ok: true,
    pending: true,
    signInKind,
    oauthState,
    verificationUri,
    expiresAt: Date.now() + SIGN_IN_TTL_MS,
    message: steps[0] ?? "Continue sign-in in your browser.",
    operatorSteps: steps,
  };
}

async function completeUserOAuth(
  env: Env,
  org: string,
  provider: UserOAuthProvider,
  callbackUrl: string | null,
): Promise<SignInVerdict> {
  const steps = oauthSteps(provider);
  if (!userProviderOAuthReady(env)) {
    return { ok: false, message: "Per-user OAuth storage is not configured.", operatorSteps: steps };
  }
  const response = await userProviderOAuthStub(env, org).fetch(
    `https://user-provider-oauth.internal/complete?provider=${provider}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callbackUrl: callbackUrl ?? "" }),
    },
  );
  const body = (await response.json().catch(() => null)) as {
    connected?: unknown;
    pending?: unknown;
    message?: unknown;
    error?: unknown;
  } | null;
  if (body?.pending === true) {
    return {
      ok: false,
      pending: true,
      message: typeof body.message === "string" ? body.message : "Still waiting. Try Finish sign-in again.",
      operatorSteps: steps,
    };
  }
  if (!response.ok || body?.connected !== true) {
    return {
      ok: false,
      message: safeMessage(body, "Sign-in could not be completed."),
      operatorSteps: steps,
    };
  }
  return {
    ok: true,
    message: typeof body?.message === "string" ? body.message : "Account connected.",
  };
}

async function inspectUserOAuth(env: Env, org: string, provider: UserOAuthProvider): Promise<SignInVerdict> {
  const steps = oauthSteps(provider);
  if (!userProviderOAuthReady(env)) {
    return { ok: false, message: "Per-user OAuth is not configured.", operatorSteps: steps };
  }
  const response = await userProviderOAuthStub(env, org).fetch(
    `https://user-provider-oauth.internal/status?provider=${provider}`,
  );
  if (!response.ok) {
    return { ok: false, message: "Connection status could not be read.", operatorSteps: steps };
  }
  const body = (await response.json().catch(() => null)) as { connected?: unknown } | null;
  if (body?.connected === true) {
    return {
      ok: true,
      message: "OAuth account is connected for this user. Egress attaches tokens; the sandbox only sees a placeholder.",
    };
  }
  return { ok: false, message: "No OAuth account is connected for this user.", operatorSteps: steps };
}

async function inspectClaude(env: Env, lanes: SignInLanes): Promise<SignInVerdict> {
  const ready = readyClaudeDaemon(await listComputers(env));
  if (ready) {
    return {
      ok: true,
      message: `Daemon ${ready.hostname} still reports the claude CLI.`,
    };
  }
  if (env.SHIBA_CLAUDE_SUBSCRIPTION === "1" && env.CLAUDE_SUBSCRIPTION_TOKEN?.trim()) {
    const controller = claudeSubscriptionAuth(env, "claude-sub:default", claudeForward(lanes));
    const current = await controller.snapshot();
    if (current.phase === "succeeded") {
      return {
        ok: true,
        message:
          current.message ??
          "Setup-token lane is authenticated.",
      };
    }
    return {
      ok: false,
      message: `No paired claude CLI, and the setup-token lane is ${current.phase}. Test does not restart sign-in.`,
      operatorSteps: CLAUDE_DAEMON_STEPS,
    };
  }
  return {
    ok: false,
    message: "No paired computer is reporting the claude CLI.",
    operatorSteps: CLAUDE_DAEMON_STEPS,
  };
}

export async function beginProviderSignIn(
  env: Env,
  provider: { id: string; label: string },
  org: string,
  ctx: SignInContext,
  lanes: SignInLanes = {},
): Promise<SignInSession> {
  if (provider.id === "codex") {
    if (ctx.mode === "setup-token") {
      return {
        ok: false,
        pending: false,
        message: "Codex has no setup-token lane. Use Connect with sign-in.",
        operatorSteps: CODEX_OPERATOR_STEPS,
      };
    }
    return beginCodex(env, org, ctx);
  }
  if (provider.id === "claude") {
    if (ctx.mode === "setup-token" && env.SHIBA_CLAUDE_SUBSCRIPTION === "1" && env.CLAUDE_SUBSCRIPTION_TOKEN?.trim()) {
      return beginClaudeSetupToken(env, org, lanes);
    }
    if (ctx.mode !== "setup-token") {
      const daemon = await beginClaudeDaemon(env, ctx);
      if (daemon.signInKind === "claude-daemon" && (daemon.ok || daemon.pending)) return daemon;
    }
    return claudePasteSession(ctx);
  }
  const oauthProvider = userOAuthProvider(provider.id);
  if (oauthProvider !== null && ctx.mode === "oauth") {
    return beginUserOAuth(env, org, oauthProvider);
  }
  return {
    ok: false,
    pending: false,
    message: `${provider.label} has no sign-in flow. Connect with the API credential instead.`,
    operatorSteps: gatewayOperatorSteps(provider.label),
  };
}

export async function completeProviderSignIn(
  env: Env,
  provider: { id: string; label: string },
  org: string,
  callbackUrl: string | null,
  credential?: string | null,
): Promise<SignInVerdict> {
  if (provider.id === "codex") {
    if (callbackUrl !== null && isLoopbackCallback(callbackUrl)) return completeCodex(env, org, callbackUrl);
    return completeDevice(env, org);
  }
  if (provider.id === "claude") {
    if (typeof credential === "string" && credential.trim() !== "") {
      return storeClaudeSetupToken(env, org, credential);
    }
    if (env[LOCAL_RUNTIME_FLAG] === "1" && env.LocalDispatch !== undefined) {
      const daemon = await completeClaudeDaemon(env);
      if (daemon.ok) return daemon;
    }
    return {
      ok: false,
      pending: true,
      message: "Paste the token from claude setup-token, then choose Finish sign-in.",
      operatorSteps: CLAUDE_SETUP_STEPS,
    };
  }
  const oauthProvider = userOAuthProvider(provider.id);
  if (oauthProvider !== null) {
    return completeUserOAuth(env, org, oauthProvider, callbackUrl);
  }
  return { ok: false, message: `${provider.label} has no sign-in to finish.` };
}

export async function inspectProviderSignIn(
  env: Env,
  provider: { id: string; label: string },
  org: string,
  lanes: SignInLanes = {},
): Promise<SignInVerdict> {
  if (provider.id === "codex") return inspectCodex(env, org);
  if (provider.id === "claude") return inspectClaude(env, lanes);
  const oauthProvider = userOAuthProvider(provider.id);
  if (oauthProvider !== null) return inspectUserOAuth(env, org, oauthProvider);
  return { ok: false, message: `${provider.label} has no subscription lane.` };
}

export function gatewayOperatorSteps(label: string): string[] {
  return [
    `${label} can use a key saved on this card. Choose Use API credential and paste the key from the provider.`,
    "The key is stored encrypted for you and attached at egress. The sandbox only sees a placeholder.",
  ];
}
