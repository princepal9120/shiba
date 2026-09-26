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
import { HARNESS_NAMES } from "./harness/index.js";
import { PROVIDER_HOSTS } from "./harness/types.js";

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const CONNECTION_SERVICES = [
  "anthropic",
  "openai",
  "google",
  "devin",
  "opencode-go",
  "cursor",
] as const;
export type ConnectionService = (typeof CONNECTION_SERVICES)[number];

export const CONNECTION_AUTH_MODES = ["gateway-byok", "worker-service-secret"] as const;
export type ConnectionAuthMode = (typeof CONNECTION_AUTH_MODES)[number];

export const CONNECTION_STATUSES = ["unconfigured", "ready", "invalid", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** The auth mode each service supports. There is deliberately no "oauth". */
export const SERVICE_AUTH_MODE: Record<ConnectionService, ConnectionAuthMode> = {
  anthropic: "gateway-byok",
  openai: "gateway-byok",
  google: "gateway-byok",
  "opencode-go": "gateway-byok",
  devin: "worker-service-secret",
  // Cursor Cloud Agents is a remote execution service, not an inference
  // endpoint: no harness drives it, and it is not in PROVIDER_HOSTS.
  cursor: "worker-service-secret",
};

/** Which env secret's *presence* a worker-service-secret connection reports. */
export const SERVICE_SECRET_ENV: Partial<Record<ConnectionService, string>> = {
  devin: "DEVIN_API_KEY",
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

export interface PurposePolicy {
  /** Monotonic; bumped on every accepted update. */
  version: number;
  /** Purpose → Workers AI model id. Absent = deployment default applies. */
  models: Partial<Record<Purpose, string>>;
  updatedAt: number;
}

export const EMPTY_POLICY: PurposePolicy = { version: 0, models: {}, updatedAt: 0 };

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
  availability: "verified" | "unverified" | "retired";
}

/** The provider namespace of a connection service (its model-id prefix). */
export function providerOfService(service: ConnectionService): string {
  // The opencode-go service serves models under the opencode-go/* namespace.
  return service;
}

/**
 * Harnesses a model on this connection can drive. A service with no
 * PROVIDER_HOSTS entry (cursor) is a remote executor — no harness runs it.
 */
export function compatibleHarnesses(service: ConnectionService): string[] {
  const provider = providerOfService(service);
  if (!(provider in PROVIDER_HOSTS)) return [];
  return HARNESS_NAMES.filter((name) => {
    if (name === "opencode") return true; // multi-provider
    if (name === "claude-code") return provider === "anthropic";
    if (name === "codex") return provider === "openai";
    if (name === "devin") return provider === "devin";
    return false;
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
        availability: connection.status === "ready" ? "verified" : "unverified",
      });
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// Approved routes
// ---------------------------------------------------------------------------

/**
 * The frozen, approval-gated route for one coding run. Recorded on the
 * pending approval, the run receipt, and the child envelope — ids only,
 * never credentials. `connectionId` null = the deployment's implicit
 * gateway/secret default for the resolved provider.
 */
export interface ApprovedRoute {
  purpose: "coding";
  connectionId: string | null;
  modelId: string;
  harness: string;
  policyVersion: number;
}

export function isApprovedRoute(value: unknown): value is ApprovedRoute {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const route = value as Record<string, unknown>;
  return (
    route.purpose === "coding" &&
    (typeof route.connectionId === "string" || route.connectionId === null) &&
    typeof route.modelId === "string" &&
    typeof route.harness === "string" &&
    typeof route.policyVersion === "number"
  );
}

/** Human-readable route summary for approval cards and run receipts. */
export function describeRoute(route: ApprovedRoute, connectionName?: string | null): string {
  const via = connectionName ?? route.connectionId ?? "deployment default";
  return `${route.harness} · ${route.modelId} · via ${via}`;
}
