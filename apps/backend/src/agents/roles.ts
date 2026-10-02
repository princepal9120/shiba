/**
 * Per-role model routing (T52). Shiba delegates work in roles — a
 * delegation may carry `role` on its input; when it does, the operator's
 * role pin resolves the harness and model before any per-call or
 * deployment default.
 *
 * Two env sources, consulted in order:
 *   - `ROLE_MODEL_MAP`: one JSON object keyed by role, each value
 *     `{"harness": "<harness>", "model"?: "<provider/model>"}`.
 *   - `ROLE_MODEL__<ROLE>` (e.g. `ROLE_MODEL__FIXER`): a single
 *     `"harness/model"` or bare `"harness"` pin used when the map has no
 *     entry for that role.
 * A role with no pin in either source resolves to `null` and the caller
 * falls back to the deployment default chain unchanged. A pin that omits
 * `model` inherits the harness's per-harness `*_MODEL` var, then
 * `HARNESS_DEFAULT_MODELS`.
 *
 * Pins are validated through the same seams runs use: `resolveHarness`
 * (unknown/gated/non-sandbox harnesses throw) and `assertSupportedModel`
 * via `allowedHostsFor` (a model whose provider has no known API host
 * throws). A malformed map or pin throws at intake — before any approval
 * card — never inside a container.
 *
 * Intended operator defaults (docs only — nothing is pinned in code):
 *   orchestrator → codex              (OpenAI-class planning)
 *   explorer     → devin-subscription (swe-2)
 *   fixer        → opencode           (deepseek)
 *   reviewer     → claude-subscription(opus-class)
 *   designer     → antigravity-subscription (Gemini)
 */
import { AGENT_ROLES, isJsonObject, type AgentRole } from "@shiba/shared";
import type { Env } from "../env.js";
import { HARNESS_DEFAULT_MODELS, resolveHarness } from "../harness/index.js";
import { assertSupportedModel, type AgentHarnessName } from "../harness/types.js";

/** Per-harness deployment model var — the `*_MODEL` precedence pins inherit. */
const HARNESS_MODEL_ENV: Partial<Record<AgentHarnessName, keyof Env>> = {
  opencode: "CODING_MODEL",
  "claude-code": "CLAUDE_CODE_MODEL",
  "claude-subscription": "CLAUDE_SUBSCRIPTION_MODEL",
  codex: "CODEX_MODEL",
  "codex-subscription": "CODEX_SUBSCRIPTION_MODEL",
  devin: "DEVIN_MODEL",
  grok: "GROK_MODEL",
  "antigravity-subscription": "ANTIGRAVITY_SUBSCRIPTION_MODEL",
  "cursor-subscription": "CURSOR_SUBSCRIPTION_MODEL",
  "devin-subscription": "DEVIN_SUBSCRIPTION_MODEL",
};

const ROLE_MODEL_VARS: Record<AgentRole, keyof Env> = {
  orchestrator: "ROLE_MODEL__ORCHESTRATOR",
  explorer: "ROLE_MODEL__EXPLORER",
  fixer: "ROLE_MODEL__FIXER",
  reviewer: "ROLE_MODEL__REVIEWER",
  designer: "ROLE_MODEL__DESIGNER",
};

/** The trimmed per-harness `*_MODEL` env value, or undefined when unset/blank. */
export function harnessModelEnv(env: Env, harness: AgentHarnessName): string | undefined {
  const key = HARNESS_MODEL_ENV[harness];
  const value = key !== undefined ? env[key] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

interface RolePin {
  harness: string;
  model?: string;
}

type RolePinSource = "role-map" | "role-env";

/** Parse `ROLE_MODEL_MAP` — throws an operator-readable message on malformed input. */
function roleModelMap(env: Env): Partial<Record<AgentRole, RolePin>> {
  const raw = env.ROLE_MODEL_MAP;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("ROLE_MODEL_MAP is not valid JSON.");
  }
  if (!isJsonObject(parsed)) {
    throw new Error("ROLE_MODEL_MAP must be a JSON object keyed by role.");
  }
  const map: Partial<Record<AgentRole, RolePin>> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!(AGENT_ROLES as readonly string[]).includes(key)) {
      throw new Error(
        `ROLE_MODEL_MAP key ${JSON.stringify(key)} is not a role; expected one of ${AGENT_ROLES.join(", ")}.`,
      );
    }
    if (!isJsonObject(value) || typeof value.harness !== "string" || value.harness.trim() === "") {
      throw new Error(
        `ROLE_MODEL_MAP.${key} must be an object like {"harness":"opencode","model":"opencode-go/deepseek-v3.2"}.`,
      );
    }
    const model = typeof value.model === "string" && value.model.trim() !== "" ? value.model.trim() : undefined;
    map[key as AgentRole] = { harness: value.harness.trim(), ...(model !== undefined ? { model } : {}) };
  }
  return map;
}

/** Parse a `ROLE_MODEL__<ROLE>` value: `"harness/model"` or bare `"harness"`. */
function parseRolePin(raw: string, varName: string): RolePin {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  const harness = slash === -1 ? trimmed : trimmed.slice(0, slash);
  const model = slash === -1 ? undefined : trimmed.slice(slash + 1).trim();
  if (harness === "") {
    throw new Error(`${varName} must be "harness/model" or "harness", got ${JSON.stringify(raw)}.`);
  }
  return model !== undefined && model !== "" ? { harness, model } : { harness };
}

/** The pin for a role and which source it came from; null when unpinned. */
function rolePin(env: Env, role: AgentRole): { pin: RolePin; source: RolePinSource } | null {
  const fromMap = roleModelMap(env)[role];
  if (fromMap !== undefined) return { pin: fromMap, source: "role-map" };
  const varName = ROLE_MODEL_VARS[role];
  const raw = env[varName];
  if (typeof raw === "string" && raw.trim() !== "") {
    return { pin: parseRolePin(raw, varName), source: "role-env" };
  }
  return null;
}

function resolvePin(env: Env, pin: RolePin): { harness: AgentHarnessName; model: string } {
  const harness = resolveHarness(pin.harness, env);
  const model = pin.model ?? harnessModelEnv(env, harness.name) ?? (HARNESS_DEFAULT_MODELS[harness.name] as string);
  // Same validation the run path applies at intake: a provider the harness
  // can't drive, or one with no known API host, throws here.
  assertSupportedModel(harness.name, harness.supportedProviders, model);
  return { harness: harness.name, model };
}

/**
 * Resolve the operator's pin for a role to a concrete harness + model,
 * or null when the role is unpinned. Harness resolution and model
 * validation reuse the run path's seams — a bad pin throws here, at
 * intake, exactly like a bad per-call harness/model would.
 */
export function resolveRoleModel(
  env: Env,
  role: AgentRole,
): { harness: AgentHarnessName; model: string } | null {
  const pinned = rolePin(env, role);
  if (pinned === null) return null;
  return resolvePin(env, pinned.pin);
}

/** One row of the `/api/setup/status` role table — the resolved routing the dashboard shows. */
export interface RoleModelStatus {
  role: AgentRole;
  /** Which env source supplied the pin; "default" = deployment fallback chain. */
  source: RolePinSource | "default";
  harness: string;
  model: string;
  /** Set when the pin (or the deployment default) is broken; harness/model are empty. */
  error?: string;
}

/** Resolved routing for every role — Settings' Models section renders this verbatim. */
export function describeRoleModels(env: Env): RoleModelStatus[] {
  return AGENT_ROLES.map((role): RoleModelStatus => {
    try {
      const pinned = rolePin(env, role);
      if (pinned !== null) {
        const resolved = resolvePin(env, pinned.pin);
        return { role, source: pinned.source, harness: resolved.harness, model: resolved.model };
      }
      const harness = resolveHarness(env.AGENT_HARNESS?.trim() ?? "opencode", env);
      return {
        role,
        source: "default",
        harness: harness.name,
        model: harnessModelEnv(env, harness.name) ?? (HARNESS_DEFAULT_MODELS[harness.name] as string),
      };
    } catch (error) {
      return {
        role,
        source: "default",
        harness: "",
        model: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
