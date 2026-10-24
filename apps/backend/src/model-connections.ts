/**
 * Model connections and purpose-based routing (spec/MODEL-CONNECTIONS-ARCHITECTURE.md).
 *
 * A *connection* is a named provider/service credential path owned by the
 * deployment — Phase 1 stores only metadata: the credential itself stays in
 * AI Gateway BYOK (injected at egress) or in a Worker secret (service APIs).
 * A *purpose policy* names the Workers AI model a non-coding purpose uses.
 *
 * This module is pure data + validation: no DO, no fetch, no secrets. The
 * Durable Object that persists these records lives in model-config-do.ts;
 * route resolution against a live deployment lives in model-policy.ts.
 *
 * Invariants enforced here:
 *  - connection ids are server-minted opaque `conn_*` strings — never a
 *    user-supplied URL or model string (those are transport destinations);
 *  - secret material is never part of a connection record — `credentialRef`
 *    names a pre-provisioned alias or secret, it never holds a key;
 *  - a model id must match the connection's provider namespace and be
 *    compatible with the harness that will run it.
 */
import { AGENT_ROLES, type AgentRole } from "@shiba/shared";
import { HARNESS_NAMES, HARNESSES } from "./harness/index.js";
import { PROVIDER_HOSTS } from "./harness/types.js";

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const CONNECTION_SERVICES = [
  "anthropic",
  "openai",
  /** Per-user ChatGPT plan via codex-subscription + Worker egress (SIWC OSS path). */
  "openai-subscription",
  "google",
  "opencode-go",
  // Grok rides the AI Gateway BYOK lane: the connection owns the gateway's
  // "grok" provider credential, and its models live in the xai/* namespace
  // (PROVIDER_HOSTS maps xai to api.x.ai).
  "grok",
  // Luan is the opencode-go routed lane for the daily-coding fleet: models
  // validate in the opencode-go/* namespace and run on the opencode
  // harness, while the connection keeps a distinct credential reference so
  // operators can rotate the fleet key without touching other connections.
  "luan",
  "cursor",
  // The ACP registry namespace: a connection in this service models
  // `acp/<registry-agent-id>` — the generic `acp` harness resolves the
  // id against the operator-pinned snapshot at admit time. It carries
  // no credential of its own; the registry allowlist is the boundary.
  "acp",
] as const;
export type ConnectionService = (typeof CONNECTION_SERVICES)[number];

export const CONNECTION_AUTH_MODES = ["gateway-byok", "worker-service-secret", "user-subscription"] as const;
export type ConnectionAuthMode = (typeof CONNECTION_AUTH_MODES)[number];

export const CONNECTION_STATUSES = ["unconfigured", "ready", "invalid", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** The auth mode each service supports. There is deliberately no "oauth". */
export const SERVICE_AUTH_MODE: Record<ConnectionService, ConnectionAuthMode> = {
  anthropic: "gateway-byok",
  openai: "gateway-byok",
  "openai-subscription": "user-subscription",
  google: "gateway-byok",
  "opencode-go": "gateway-byok",
  // Grok models egress through the AI Gateway's grok provider BYOK
  // credential (api.x.ai). No Worker secret is provisioned for it.
  grok: "gateway-byok",
  // Luan models validate in the opencode-go namespace and egress through
  // the same gateway provider; the separate service id exists so the fleet
  // lane keeps its own connection record and credential reference.
  luan: "gateway-byok",
  // Cursor Cloud Agents is a remote execution service, not an inference
  // endpoint: no harness drives it, and it is not in PROVIDER_HOSTS.
  cursor: "worker-service-secret",
  // acp connections provision no credential through either lane — the
  // registry agent's own env block declares what it reads, and any real
  // key is a per-agent concern the allowlist names. The mode label is a
  // formality for the union; no secret env var maps to it.
  acp: "worker-service-secret",
};

/** Which env secret's *presence* a worker-service-secret connection reports. */
/** @public */
export const SERVICE_SECRET_ENV: Partial<Record<ConnectionService, string>> = {
  cursor: "CURSOR_API_KEY",
};

export interface Connection {
  /** Server-minted opaque id (`conn_*`). Never derived from user input. */
  id: string;
  /** Phase 1 is deployment-owned only; personal scope is a separate design. */
  owner: "deployment";
  service: ConnectionService;
  authMode: ConnectionAuthMode;
  status: ConnectionStatus;
  displayName: string;
  /**
   * Names the pre-provisioned credential — an AI Gateway BYOK alias or a
   * Worker secret name. It is a *reference*, never secret material.
   */
  credentialRef: string | null;
  createdAt: number;
  updatedAt: number;
  /** Wall-clock of the last owner-triggered test; null until one ran. */
  lastCheckedAt: number | null;
}

/** Wire projection: everything a dashboard may see. Contains no secrets. */
/** @public */
export function publicConnection(connection: Connection): Connection {
  return { ...connection };
}

// ---------------------------------------------------------------------------
// Purposes and the purpose policy
// ---------------------------------------------------------------------------

export const PURPOSES = [
  "orchestrator",
  "coding",
  "automation_gate",
  "intent",
  "quality",
  "distillation",
  // Non-coding Workers AI purposes (spec §4): the PR review lane plans on
  // "review", plan-only runs on "plan", and UI-copy passes on "ui". Each is
  // policy-settable like orchestrator; `coding` stays out of the policy —
  // it routes per run through the connection catalog.
  "review",
  "plan",
  "ui",
] as const;
export type Purpose = (typeof PURPOSES)[number];

export function isPurpose(value: unknown): value is Purpose {
  return typeof value === "string" && (PURPOSES as readonly string[]).includes(value);
}

/**
 * Workers AI is the only model source non-coding purposes may name: the
 * parent agent, run_when gate, and distillation all call `env.AI.run`.
 * External-LLM parents are a separate adapter design (spec §4).
 */
export const WORKERS_AI_MODEL_RE = /^@cf\/[a-z0-9][a-z0-9./_-]{1,127}$/i;

/** Dashboard-editable pin for one agent role (harness + optional model). */
export interface DashboardRolePin {
  harness: string;
  model?: string;
}

export interface PurposePolicy {
  /** Monotonic; bumped on every accepted update. */
  version: number;
  /** Purpose → Workers AI model id. Absent = deployment default applies. */
  models: Partial<Record<Purpose, string>>;
  /** Operator pins from Settings → Models; wins over wrangler ROLE_MODEL_* vars. */
  rolePins?: Partial<Record<AgentRole, DashboardRolePin>>;
  updatedAt: number;
}

export const EMPTY_POLICY: PurposePolicy = { version: 0, models: {}, updatedAt: 0 };

/** Sort connections by the stored order list; unknown ids trail by createdAt. */
export function orderConnections(connections: Connection[], order: string[]): Connection[] {
  if (order.length === 0) return connections;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...connections].sort((a, b) => {
    const ai = rank.get(a.id);
    const bi = rank.get(b.id);
    if (ai !== undefined && bi !== undefined) return ai - bi;
    if (ai !== undefined) return -1;
    if (bi !== undefined) return 1;
    return a.createdAt - b.createdAt;
  });
}

/** Validate a rolePins object from a policy PUT. */
export function validateRolePins(input: unknown): { rolePins: PurposePolicy["rolePins"] } | { error: string } {
  if (input === undefined || input === null) {
    return { rolePins: undefined };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { error: "rolePins must be a JSON object keyed by role." };
  }
  const rolePins: PurposePolicy["rolePins"] = {};
  for (const [role, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(AGENT_ROLES as readonly string[]).includes(role)) {
      return { error: `Unknown role ${JSON.stringify(role)}.` };
    }
    if (value === null) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { error: `rolePins.${role} must be {"harness":"…","model":"…"} or null to clear.` };
    }
    const harness = (value as Record<string, unknown>).harness;
    if (typeof harness !== "string" || harness.trim() === "") {
      return { error: `rolePins.${role}.harness must be a non-empty string.` };
    }
    const modelRaw = (value as Record<string, unknown>).model;
    const model =
      typeof modelRaw === "string" && modelRaw.trim() !== "" ? modelRaw.trim() : undefined;
    rolePins[role as AgentRole] = model !== undefined ? { harness: harness.trim(), model } : { harness: harness.trim() };
  }
  return { rolePins };
}

/** Normalize connectionOrder after register/disable — drop missing ids, append new ones. */
export function reconcileConnectionOrder(connections: Connection[], order: string[]): string[] {
  const ids = new Set(connections.map((c) => c.id));
  const next = order.filter((id) => ids.has(id));
  for (const connection of connections) {
    if (!next.includes(connection.id)) next.push(connection.id);
  }
  return next;
}

/**
 * Validate a policy update. `coding` is not settable: coding routes resolve
 * per run through the connection catalog and the delegate input, never
 * through a prose policy string. Returns the normalized models map.
 */
export function validatePolicyModels(input: unknown): { models: PurposePolicy["models"] } | { error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "models must be a JSON object mapping purpose to model id." };
  }
  const models: PurposePolicy["models"] = {};
  for (const [purpose, model] of Object.entries(input as Record<string, unknown>)) {
    if (!isPurpose(purpose)) {
      return { error: `Unknown purpose ${JSON.stringify(purpose)}.` };
    }
    if (purpose === "coding") {
      return { error: "The coding purpose is routed per run via connections, not the purpose policy." };
    }
    if (purpose === "intent" || purpose === "quality") {
      return { error: `The ${purpose} purpose is TypeSafe-only; there is no model to configure.` };
    }
    if (model === null || model === "") continue; // clearing an entry
    if (typeof model !== "string" || !WORKERS_AI_MODEL_RE.test(model.trim())) {
      return { error: `Model for ${purpose} must be a Workers AI id like @cf/meta/llama-3.1-8b-instruct.` };
    }
    models[purpose] = model.trim();
  }
  return { models };
}

// ---------------------------------------------------------------------------
// Model options and compatibility
// ---------------------------------------------------------------------------

export interface ModelOption {
  connectionId: string;
  /** Vendor/model id in provider/model form, e.g. anthropic/claude-sonnet-4-6. */
  modelId: string;
  compatibleHarnesses: string[];
  purposes: Purpose[];
  /**
   * "configured" means the operator marked the connection ready — it is a
   * declaration, not a wire check: nothing probes the credential end to end.
   * A real "verified" tier only exists once live probing lands.
   */
  availability: "configured" | "unverified" | "retired";
}

/** The provider namespace of a connection service (its model-id prefix). */
export function providerOfService(service: ConnectionService): string {
  // The opencode-go service serves models under the opencode-go/* namespace.
  // grok is the AI Gateway slug for the xAI host — its models are xai/*.
  if (service === "grok") return "xai";
  // luan is a fleet lane routed through the opencode-go provider; its
  // models validate in the opencode-go/* namespace.
  if (service === "luan") return "opencode-go";
  if (service === "openai-subscription") return "openai-subscription";
  return service;
}

/**
 * Harnesses a model on this connection can drive. Cursor is a remote
 * executor — its PROVIDER_HOSTS row exists only so the (unwired) harness can
 * name an egress host, not because a sandbox harness runs its models.
 */
export function compatibleHarnesses(service: ConnectionService): string[] {
  if (service === "cursor") return [];
  // `acp` is a registry-driven namespace: the one generic harness covers
  // every allowlisted agent (it declares providers ["acp"]). The env gate
  // (ACP_REGISTRY_ALLOWLIST) applies at resolveHarness time, not here.
  if (service === "acp") return ["acp"];
  const provider = providerOfService(service);
  if (!(provider in PROVIDER_HOSTS)) return [];
  // Compatibility is the harness's own declaration: supportedProviders is
  // the only list — ACP and future lanes join automatically, a stale name
  // check here could never lie about them. Runnability is the second gate:
  // a registered-but-unrunnable harness (antigravity, cursor — both declare
  // supportedRuntimes: [] and resolveHarness refuses them) must not be
  // advertised as a compatible route the dispatcher then rejects.
  return HARNESS_NAMES.filter((name) => {
    const harness = HARNESSES[name];
    return (
      harness?.supportedProviders.includes(provider) === true &&
      harness.capabilities().supportedRuntimes.includes("sandbox")
    );
  });
}

/**
 * Validate a requested coding model against a connection. The model id must
 * live in the connection's provider namespace and be runnable by the chosen
 * harness. Returns an error string, or null when the pair is admissible.
 */
export function validateConnectionModel(
  connection: Pick<Connection, "service" | "status">,
  modelId: string,
  harness: string,
): string | null {
  if (connection.status === "disabled") {
    return "This connection is disabled.";
  }
  const provider = providerOfService(connection.service);
  if (!(provider in PROVIDER_HOSTS)) {
    return `${connection.service} is a remote execution service, not a coding model provider.`;
  }
  const slash = modelId.indexOf("/");
  if (slash <= 0 || slash === modelId.length - 1) {
    return `Model id must be in provider/model form, e.g. ${provider}/…`;
  }
  if (modelId.slice(0, slash) !== provider) {
    return `Model ${JSON.stringify(modelId)} does not belong to the ${provider} connection.`;
  }
  const harnesses = compatibleHarnesses(connection.service);
  if (!harnesses.includes(harness)) {
    return `The ${harness} harness cannot run ${provider} models (supported: ${harnesses.join(", ") || "none"}).`;
  }
  return null;
}

/**
 * The catalog of selectable coding models: one entry per ready/unconfigured
 * gateway connection × its candidate models. `modelsByService` lists the
 * deployment's known-live ids per service (static defaults plus operator
 * additions); ids are validated, never invented here.
 */
/** @public */
export function modelOptionsForPurpose(
  connections: Connection[],
  purpose: Purpose,
  modelsByService: Partial<Record<ConnectionService, string[]>>,
): ModelOption[] {
  if (purpose !== "coding") return [];
  const options: ModelOption[] = [];
  for (const connection of connections) {
    if (connection.status === "disabled") continue;
    const harnesses = compatibleHarnesses(connection.service);
    if (harnesses.length === 0) continue;
    for (const modelId of modelsByService[connection.service] ?? []) {
      options.push({
        connectionId: connection.id,
        modelId,
        compatibleHarnesses: harnesses,
        purposes: ["coding"],
        availability: connection.status === "ready" ? "configured" : "unverified",
      });
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Approved routes
// ---------------------------------------------------------------------------

// The frozen route record is a wire type — it lives in @shiba/shared and
// is re-exported here for existing imports.
export { describeRoute, isApprovedRoute } from "@shiba/shared";
export type { ApprovedRoute } from "@shiba/shared";
