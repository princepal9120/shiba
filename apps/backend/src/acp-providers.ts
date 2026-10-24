import {
  type AcpAuthMode,
  type AcpProviderCapabilities,
  type AcpProviderCard,
  type AcpProviderConnection,
  type AcpProviderId,
  type AcpProvidersSnapshot,
  type AcpSignInKind,
  isAcpProviderId,
} from "@shiba/shared";
import type { Env } from "./env.js";
import { userProviderOAuthStub } from "./user-provider-oauth-do.js";
import { userProviderOAuthReady } from "./user-provider-oauth-store.js";
import { ACP_LANES, HARNESS_DEFAULT_MODELS, HARNESSES } from "./harness/index.js";
import { gatewayOperatorSteps } from "./provider-sign-in.js";
import {
  assertPastableSecret,
  deleteUserProviderSecret,
  pasteProviderKind,
  putUserProviderSecret,
  readUserProviderSecret,
} from "./user-provider-keys.js";
import type { AgentHarnessName } from "./harness/types.js";
import { InputError } from "./security.js";

const DEVICE_TTL_MS = 15 * 60 * 1000;
const RECORD_PREFIX = "acp_provider:";
const DEFAULT_PREFIX = "acp_provider_default:";

export class ProviderFlowError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ProviderFlowError";
  }
}

interface ProviderDefinition {
  id: AcpProviderId;
  label: string;
  blurb: string;
  adapter: string;
  packageName: string;
  license: string;
  harness: AgentHarnessName;
  protocol: "acp" | "cli";
  spawn: readonly string[];
  docsUrl: string;
  oauth: boolean;
  subscription: "claude-subscription" | "codex-subscription" | "cursor-subscription" | null;
  credentialEnv: readonly string[];
}

interface StoredConnection {
  phase: "waiting" | "connected" | "failed";
  authMode: AcpAuthMode;
  message?: string;
  userCode?: string;
  verificationUri?: string;
  signInKind?: AcpSignInKind;
  oauthState?: string;
  operatorSteps?: string[];
  expiresAt?: number;
  testedAt?: number;
  testOk?: boolean;
  updatedAt: number;
}

const DISCONNECTED: AcpProviderConnection = {
  phase: "disconnected",
  authMode: null,
  message: null,
  userCode: null,
  verificationUri: null,
  expiresAt: null,
  testedAt: null,
  testOk: null,
  signInKind: null,
  oauthState: null,
  operatorSteps: [],
};

const RETIRED_SIGN_IN_URIS = new Set(["https://chatgpt.com/", "https://claude.ai/login"]);

function capabilities(
  harness: AgentHarnessName,
  extra: Pick<AcpProviderCapabilities, "oauth" | "apiKey" | "acp" | "permissions" | "setModel">,
): AcpProviderCapabilities {
  const harnessImpl = HARNESSES[harness];
  if (harnessImpl === undefined) {
    throw new Error(`ACP provider registry references unknown harness ${harness}.`);
  }
  const declared = harnessImpl.capabilities();
  return {
    streamsText: declared.streamsText,
    toolCalls: declared.emitsToolCalls,
    permissions: extra.permissions,
    setModel: extra.setModel,
    oauth: extra.oauth,
    apiKey: extra.apiKey,
    acp: extra.acp,
  };
}

export const ACP_PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  {
    id: "claude",
    label: "Claude Code",
    blurb:
      "Claude Code on your own machine. Connect pairs a local daemon, or you paste a token from the Claude CLI.",
    adapter: "claude-agent-acp",
    packageName: "@agentclientprotocol/claude-agent-acp",
    license: "Apache-2.0",
    harness: "claude-acp",
    protocol: "acp",
    spawn: ACP_LANES["claude-acp"].spec.spawn,
    docsUrl: "https://agentclientprotocol.com",
    oauth: true,
    subscription: "claude-subscription",
    credentialEnv: ["AI_GATEWAY_TOKEN"],
  },
  {
    id: "codex",
    label: "Codex",
    blurb:
      "Codex via your ChatGPT plan (Sign in with ChatGPT). The access token is encrypted per user and attached at egress.",
    adapter: "codex-acp",
    packageName: "@agentclientprotocol/codex-acp",
    license: "Apache-2.0",
    harness: "codex-acp",
    protocol: "acp",
    spawn: ACP_LANES["codex-acp"].spec.spawn,
    docsUrl: "https://agentclientprotocol.com",
    oauth: true,
    subscription: "codex-subscription",
    credentialEnv: ["AI_GATEWAY_TOKEN"],
  },
  {
    id: "gemini",
    label: "Gemini (Antigravity)",
    blurb:
      "Google Antigravity / Cloud Code Assist via the agy ACP agent. Connect with Google OAuth, or paste a Gemini API key for gemini --acp.",
    adapter: "gemini",
    packageName: "@google/gemini-cli",
    license: "Apache-2.0",
    harness: "antigravity-subscription",
    protocol: "acp",
    spawn: ["agy", "--no-interactive"],
    docsUrl: "https://antigravity.google",
    oauth: true,
    subscription: null,
    credentialEnv: ["AI_GATEWAY_TOKEN"],
  },
  {
    id: "grok",
    label: "Grok",
    blurb:
      "Grok via the pinned CLI. Connect with your xAI account, or paste an API key. Egress attaches credentials; the sandbox only sees a placeholder.",
    adapter: "grok",
    packageName: "@xai-official/grok",
    license: "see package",
    harness: "grok",
    protocol: "cli",
    spawn: ["grok", "--single"],
    docsUrl: "https://docs.x.ai",
    oauth: true,
    subscription: null,
    credentialEnv: ["AI_GATEWAY_TOKEN"],
  },
  {
    id: "cursor",
    label: "Cursor",
    blurb:
      "Cursor Agent (`cursor-agent` ACP). Connect with your Cursor account, or use a deployment API key. Tokens stay on the Worker at egress.",
    adapter: "cursor-agent",
    packageName: "cursor-agent",
    license: "see package",
    harness: "cursor-subscription",
    protocol: "acp",
    spawn: ["cursor-agent", "--force", "acp"],
    docsUrl: "https://docs.cursor.com",
    oauth: true,
    subscription: "cursor-subscription",
    credentialEnv: ["CURSOR_SUBSCRIPTION_TOKEN"],
  },
];

const BY_ID = new Map(ACP_PROVIDER_REGISTRY.map((provider) => [provider.id, provider]));

export function acpProvider(id: string): ProviderDefinition {
  if (!isAcpProviderId(id)) {
    throw new ProviderFlowError(`Unknown provider ${JSON.stringify(id)}.`, 404);
  }
  const provider = BY_ID.get(id);
  if (provider === undefined) {
    throw new ProviderFlowError(`Unknown provider ${JSON.stringify(id)}.`, 404);
  }
  return provider;
}

export function acpAdapterPlan(id: AcpProviderId): {
  providerId: AcpProviderId;
  harness: AgentHarnessName;
  model: string;
  spawn: readonly string[];
} {
  const provider = acpProvider(id);
  if (provider.protocol !== "acp") {
    throw new ProviderFlowError(
      `${provider.label} does not speak ACP in this image. Runs use the ${provider.harness} harness.`,
      400,
    );
  }
  return {
    providerId: id,
    harness: provider.harness,
    model: HARNESS_DEFAULT_MODELS[provider.harness] as string,
    spawn: provider.spawn,
  };
}

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

export interface ProviderDeps {
  now?: () => number;
  origin?: string;
  beginOauth?: (
    env: Env,
    provider: ProviderDefinition,
    org: string,
    ctx: SignInContext,
  ) => Promise<SignInSession>;
  completeOauth?: (
    env: Env,
    provider: ProviderDefinition,
    org: string,
    callbackUrl: string | null,
    credential?: string | null,
  ) => Promise<SignInVerdict>;
  /** Pasted API key or Claude setup-token. Never written into the connection record. */
  credential?: string;
  inspectOauth?: (env: Env, provider: ProviderDefinition, org: string) => Promise<SignInVerdict>;
}

function nowMs(deps: ProviderDeps): number {
  return deps.now?.() ?? Date.now();
}

function kvOf(env: Env): KVNamespace | null {
  return env.AGENT_TOKENS ?? null;
}

function recordKey(org: string, id: AcpProviderId): string {
  return `${RECORD_PREFIX}${encodeURIComponent(org)}:${id}`;
}

function defaultKey(org: string): string {
  return `${DEFAULT_PREFIX}${encodeURIComponent(org)}`;
}

async function readRecord(
  env: Env,
  org: string,
  id: AcpProviderId,
): Promise<StoredConnection | null> {
  const kv = kvOf(env);
  if (kv === null) return null;
  let raw: string | null;
  try {
    raw = await kv.get(recordKey(org, id), { type: "text" });
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as StoredConnection;
    if (parsed.phase !== "waiting" && parsed.phase !== "connected" && parsed.phase !== "failed") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function writeRecord(
  env: Env,
  org: string,
  id: AcpProviderId,
  record: StoredConnection,
): Promise<void> {
  const kv = kvOf(env);
  if (kv === null) {
    throw new ProviderFlowError("Provider connection store is not configured.", 503);
  }
  try {
    await kv.put(recordKey(org, id), JSON.stringify(record));
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
}

async function deleteRecord(env: Env, org: string, id: AcpProviderId): Promise<void> {
  const kv = kvOf(env);
  if (kv === null) return;
  try {
    await kv.delete(recordKey(org, id));
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
}

async function readDefault(env: Env, org: string): Promise<AcpProviderId | null> {
  const kv = kvOf(env);
  if (kv === null) return null;
  let raw: string | null;
  try {
    raw = await kv.get(defaultKey(org), { type: "text" });
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
  return raw !== null && isAcpProviderId(raw) ? raw : null;
}

async function writeDefault(env: Env, org: string, id: AcpProviderId | null): Promise<void> {
  const kv = kvOf(env);
  if (kv === null) {
    throw new ProviderFlowError("Provider connection store is not configured.", 503);
  }
  try {
    if (id === null) await kv.delete(defaultKey(org));
    else await kv.put(defaultKey(org), id);
  } catch {
    throw new ProviderFlowError("Provider connection store is unreachable.", 503);
  }
}

function presentCredential(env: Env, names: readonly string[]): string | null {
  const record = env as unknown as Record<string, unknown>;
  for (const name of names) {
    const value = record[name];
    if (typeof value === "string" && value.trim() !== "") return name;
  }
  return null;
}

const STALE_FAILURE = /AI_GATEWAY_TOKEN|SHIBA_CLAUDE_SUBSCRIPTION|CLAUDE_SUBSCRIPTION_TOKEN|No credential is provisioned|not enabled/;

function publicConnection(record: StoredConnection | null, now: number): AcpProviderConnection {
  if (record === null) return DISCONNECTED;
  const retired =
    record.verificationUri !== undefined && RETIRED_SIGN_IN_URIS.has(record.verificationUri);
  const expired =
    record.phase === "waiting" && record.expiresAt !== undefined && record.expiresAt <= now;
  if (record.phase === "failed" && STALE_FAILURE.test(record.message ?? "")) {
    return DISCONNECTED;
  }
  if (retired) {
    return {
      phase: "failed",
      authMode: record.authMode,
      message:
        "That sign-in code was generated on this page and was never sent to ChatGPT or Claude. Start sign-in again.",
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      testedAt: record.testedAt ?? null,
      testOk: record.testOk ?? null,
      signInKind: null,
      operatorSteps: ["Choose Connect with sign-in. The card shows the real address and the exact steps."],
    };
  }
  return {
    phase: expired ? "failed" : record.phase,
    authMode: record.authMode,
    message: expired ? "Sign-in expired. Start again." : (record.message ?? null),
    userCode: !expired && record.signInKind === "chatgpt-device" ? (record.userCode ?? null) : null,
    verificationUri: expired ? null : (record.verificationUri ?? null),
    expiresAt: record.expiresAt ?? null,
    testedAt: record.testedAt ?? null,
    testOk: record.testOk ?? null,
    signInKind: expired ? null : (record.signInKind ?? null),
    oauthState:
      expired || record.phase !== "waiting" ? null : (record.oauthState ?? null),
    operatorSteps: expired ? ["Choose Connect with sign-in again."] : (record.operatorSteps ?? []),
  };
}

/** Pending OAuth state for loopback dev polling — only while waiting. */
export async function waitingProviderOauthState(
  env: Env,
  org: string,
  id: AcpProviderId,
): Promise<string | null> {
  const record = await readRecord(env, org, id);
  if (record === null || record.phase !== "waiting") return null;
  const state = record.oauthState?.trim() ?? "";
  return state === "" ? null : state;
}

function effectiveHarness(provider: ProviderDefinition, record: StoredConnection | null): AgentHarnessName {
  if (provider.id === "gemini" && record?.authMode === "api-key") {
    return "gemini-acp";
  }
  return provider.harness;
}

function effectiveSpawn(provider: ProviderDefinition, harness: AgentHarnessName): string[] {
  if (harness === "gemini-acp") {
    return [...ACP_LANES["gemini-acp"].spec.spawn];
  }
  return [...provider.spawn];
}

function toCard(
  provider: ProviderDefinition,
  record: StoredConnection | null,
  defaultId: AcpProviderId | null,
  now: number,
): AcpProviderCard {
  const harness = effectiveHarness(provider, record);
  return {
    id: provider.id,
    label: provider.label,
    blurb: provider.blurb,
    adapter: provider.adapter,
    packageName: provider.packageName,
    license: provider.license,
    harness,
    protocol: provider.protocol,
    spawn: effectiveSpawn(provider, harness),
    defaultModel: HARNESS_DEFAULT_MODELS[harness] as string,
    docsUrl: provider.docsUrl,
    capabilities: capabilities(harness, {
      oauth: provider.oauth,
      apiKey: true,
      acp: provider.protocol === "acp",
      permissions: provider.protocol === "acp",
      setModel: provider.protocol === "acp",
    }),
    credentialEnv: [...provider.credentialEnv],
    connection: publicConnection(record, now),
    isDefault: defaultId === provider.id,
  };
}

export async function readProviderSnapshot(
  env: Env,
  org: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const now = nowMs(deps);
  const defaultId = await readDefault(env, org);
  const providers = await Promise.all(
    ACP_PROVIDER_REGISTRY.map(async (provider) =>
      toCard(provider, await readRecord(env, org, provider.id), defaultId, now),
    ),
  );
  return { org, defaultProviderId: defaultId, providers };
}

function storedFromSession(session: SignInSession, now: number): StoredConnection {
  return {
    phase: session.pending ? "waiting" : session.ok ? "connected" : "failed",
    authMode: "oauth",
    message: session.message,
    ...(session.userCode ? { userCode: session.userCode } : {}),
    ...(session.verificationUri ? { verificationUri: session.verificationUri } : {}),
    ...(session.signInKind ? { signInKind: session.signInKind } : {}),
    ...(session.oauthState ? { oauthState: session.oauthState } : {}),
    ...(session.operatorSteps ? { operatorSteps: session.operatorSteps } : {}),
    ...(session.pending ? { expiresAt: session.expiresAt ?? now + DEVICE_TTL_MS } : {}),
    updatedAt: now,
  };
}

export async function connectProvider(
  env: Env,
  org: string,
  id: string,
  mode: unknown,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const now = nowMs(deps);
  if (mode === "oauth" || mode === "setup-token") {
    if (mode === "oauth" && !provider.oauth) {
      throw new InputError(
        `${provider.label} has no sign-in flow. Connect with the API credential instead.`,
      );
    }
    if (mode === "setup-token" && provider.id !== "claude") {
      throw new InputError(`${provider.label} has no setup-token lane.`);
    }
    const begin = deps.beginOauth;
    if (begin === undefined) {
      throw new ProviderFlowError("Sign-in is not configured.", 500);
    }
    const session = await begin(env, provider, org, {
      mode,
      origin: deps.origin ?? "",
      now,
    });
    await writeRecord(env, org, provider.id, storedFromSession(session, now));
    return readProviderSnapshot(env, org, deps);
  }
  if (mode === "api-key") {
    const pasteKind = pasteProviderKind(provider.id);
    const pasted = typeof deps.credential === "string" ? deps.credential : "";
    if (pasteKind && pasted.trim() !== "") {
      try {
        const secret = assertPastableSecret(pasted);
        await putUserProviderSecret(env, org, pasteKind, secret);
      } catch (error) {
        const message = error instanceof Error ? error.message : "The key could not be stored.";
        const status = message.includes("not ready") ? 503 : 400;
        throw new ProviderFlowError(message, status);
      }
      await writeRecord(env, org, provider.id, {
        phase: "connected",
        authMode: "api-key",
        message: `${provider.label} key stored for this user. Egress sends it to the provider. The sandbox only sees a placeholder.`,
        updatedAt: now,
      });
      return readProviderSnapshot(env, org, deps);
    }
    if (pasteKind && pasted.trim() === "") {
      const existing = await readUserProviderSecret(env, org, pasteKind);
      if (existing) {
        await writeRecord(env, org, provider.id, {
          phase: "connected",
          authMode: "api-key",
          message: `${provider.label} key is already stored for this user. Egress sends it to the provider.`,
          updatedAt: now,
        });
        return readProviderSnapshot(env, org, deps);
      }
    }
    const name = presentCredential(env, provider.credentialEnv);
    if (name === null) {
      return readProviderSnapshot(env, org, deps);
    }
    await writeRecord(env, org, provider.id, {
      phase: "connected",
      authMode: "api-key",
      message: `Using ${name}. The sandbox adapter receives a dummy key; egress attaches this credential for the ${provider.harness} harness.`,
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  throw new InputError('mode must be "oauth", "setup-token", or "api-key".');
}

export async function verifyProvider(
  env: Env,
  org: string,
  id: string,
  callbackUrl: unknown,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const now = nowMs(deps);
  const record = await readRecord(env, org, provider.id);
  if (record === null || record.phase !== "waiting") {
    throw new ProviderFlowError("There is no sign-in in progress for this provider.", 409);
  }
  if (record.expiresAt !== undefined && record.expiresAt <= now) {
    await writeRecord(env, org, provider.id, {
      ...record,
      phase: "failed",
      message: "Sign-in expired. Start again.",
      userCode: undefined,
      verificationUri: undefined,
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  const complete = deps.completeOauth;
  if (complete === undefined) {
    throw new ProviderFlowError("Sign-in confirmation is not configured.", 500);
  }
  const pasted = typeof callbackUrl === "string" && callbackUrl.trim() !== "" ? callbackUrl.trim() : null;
  const credential = typeof deps.credential === "string" && deps.credential.trim() !== "" ? deps.credential : null;
  const verdict = await complete(env, provider, org, pasted, credential);
  const fresh = await readRecord(env, org, provider.id);
  if (fresh === null || fresh.phase !== "waiting" || fresh.updatedAt !== record.updatedAt) {
    return readProviderSnapshot(env, org, deps);
  }
  if (verdict.pending) {
    await writeRecord(env, org, provider.id, {
      ...fresh,
      phase: "waiting",
      message: verdict.message,
      ...(verdict.operatorSteps ? { operatorSteps: verdict.operatorSteps } : {}),
      updatedAt: now,
    });
    return readProviderSnapshot(env, org, deps);
  }
  await writeRecord(env, org, provider.id, {
    phase: verdict.ok ? "connected" : "failed",
    authMode: "oauth",
    message: verdict.message,
    ...(fresh.signInKind ? { signInKind: fresh.signInKind } : {}),
    ...(verdict.operatorSteps ? { operatorSteps: verdict.operatorSteps } : {}),
    updatedAt: now,
  });
  return readProviderSnapshot(env, org, deps);
}

export async function testProvider(
  env: Env,
  org: string,
  id: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const now = nowMs(deps);
  const record = await readRecord(env, org, provider.id);
  if (record === null || record.phase !== "connected") {
    throw new ProviderFlowError("Connect the provider before testing it.", 409);
  }
  let ok = false;
  let message = record.message ?? "Test failed.";
  let operatorSteps = record.operatorSteps;
  if (record.authMode === "api-key") {
    const pasteKind = pasteProviderKind(provider.id);
    if (pasteKind) {
      const saved = await readUserProviderSecret(env, org, pasteKind);
      ok = saved !== null;
      message = ok
        ? "Saved key is stored for this user. Egress attaches it. The sandbox only sees a placeholder."
        : "No saved key for this user.";
      operatorSteps = ok ? undefined : gatewayOperatorSteps(provider.label);
    } else {
      const name = presentCredential(env, provider.credentialEnv);
      ok = name !== null;
      if (ok) {
        message = `Credential ${name} is still present.`;
        operatorSteps = undefined;
      } else {
        operatorSteps = gatewayOperatorSteps(provider.label);
        message = operatorSteps[0] ?? "Credential missing.";
      }
    }
  } else if (deps.inspectOauth !== undefined) {
    const verdict = await deps.inspectOauth(env, provider, org);
    ok = verdict.ok;
    message = verdict.message;
    operatorSteps = verdict.operatorSteps;
  }
  const fresh = await readRecord(env, org, provider.id);
  if (fresh === null || fresh.phase !== "connected" || fresh.updatedAt !== record.updatedAt) {
    return readProviderSnapshot(env, org, deps);
  }
  await writeRecord(env, org, provider.id, {
    ...fresh,
    message,
    ...(operatorSteps ? { operatorSteps } : { operatorSteps: undefined }),
    testedAt: now,
    testOk: ok,
    updatedAt: now,
  });
  return readProviderSnapshot(env, org, deps);
}

export async function disconnectProvider(
  env: Env,
  org: string,
  id: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const pasteKind = pasteProviderKind(provider.id);
  if (pasteKind) await deleteUserProviderSecret(env, org, pasteKind);
  if (provider.id === "claude") await deleteUserProviderSecret(env, org, "claude-setup");
  if (userProviderOAuthReady(env)) {
    const oauth =
      provider.id === "gemini"
        ? "antigravity"
        : provider.id === "grok"
          ? "xai"
          : provider.id === "cursor"
            ? "cursor"
            : null;
    if (oauth !== null) {
      await userProviderOAuthStub(env, org).fetch(`https://user-provider-oauth.internal/logout?provider=${oauth}`, {
        method: "DELETE",
      });
    }
  }
  await deleteRecord(env, org, provider.id);
  if ((await readDefault(env, org)) === provider.id) {
    await writeDefault(env, org, null);
  }
  return readProviderSnapshot(env, org, deps);
}

export async function setDefaultProvider(
  env: Env,
  org: string,
  id: string,
  deps: ProviderDeps = {},
): Promise<AcpProvidersSnapshot> {
  const provider = acpProvider(id);
  const record = await readRecord(env, org, provider.id);
  if (record === null || record.phase !== "connected") {
    throw new ProviderFlowError("Only a connected provider can be the org default.", 409);
  }
  await writeDefault(env, org, provider.id);
  return readProviderSnapshot(env, org, deps);
}

export type { ProviderDefinition };
