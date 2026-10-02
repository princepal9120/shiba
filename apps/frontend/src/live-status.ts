/**
 * Live deployment status reads shared by the Integrations, Settings, and
 * Analytics surfaces. Every hook settles to an explicit state — data, an
 * error, or "route dark" — so a panel reports what the deployment proves
 * and never renders optimistic state.
 */
import { useCallback, useEffect, useState } from "react";
import type { AuthSnapshot } from "@shiba/shared";
import type { AgentPrincipal, InboxMailbox } from "./types";

/** Wire shape of `GET /api/setup/status` (backend `setup-status.ts`). Booleans only. */
export interface SetupStatus {
  slack: { signingSecret: boolean; botToken: boolean; approvers: number; channelRepos: boolean };
  github: { token: boolean; webhookSecret: boolean };
  gateway: { id: string; token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" };
  access: { required: boolean };
  models: { orchestrator: string; coding: string; harness: string; roles: RoleModelWire[] };
  automations: { enabled: boolean; typeSafe: boolean };
}

/**
 * One `models.roles[]` entry — the backend's RoleModelStatus
 * (agents/roles.ts) served verbatim. `source` says which env layer the
 * resolved pair came from; `error` marks a broken pin.
 */
export interface RoleModelWire {
  role: string;
  source: "role-map" | "role-env" | "default";
  harness: string;
  model: string;
  error?: string;
}

/**
 * Wire shape of one `agents[]` entry from `GET /api/agents` — the backend's
 * AgentCliInfo (harness/catalog.ts) served verbatim. Projected locally: the
 * dashboard must not import `apps/backend` sources.
 */
export interface AgentCliEntry {
  id: string;
  label: string;
  binary: string;
  version: string;
  defaultModel: string;
  credential: {
    kind: "ai-gateway-byok" | "worker-secret" | "oauth-signin";
    label: string;
    /** true = secret present, false = missing, null = not introspectable. */
    configured: boolean | null;
    setupHint: string | null;
  };
  docsUrl: string;
}

export interface AgentsDirectory {
  agents: AgentCliEntry[];
  principals: AgentPrincipal[];
}

/** One fetch's settled state: still in flight, failed, or carrying data. */
export type LoadState<T> =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "data"; data: T };

function useApiJson<T>(path: string): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch(path)
      .then(async (response) => {
        if (!response.ok) throw new Error(`GET ${path} failed: ${response.status}`);
        const body = (await response.json()) as T;
        if (!cancelled) setState({ kind: "data", data: body });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}

export function useSetupStatus(): { state: LoadState<SetupStatus>; reload: () => void } {
  return useApiJson<SetupStatus>("/api/setup/status");
}

export function useAgentsDirectory(): { state: LoadState<AgentsDirectory>; reload: () => void } {
  return useApiJson<AgentsDirectory>("/api/agents");
}

export function useMailboxes(): { state: LoadState<{ mailboxes: InboxMailbox[] }>; reload: () => void } {
  return useApiJson<{ mailboxes: InboxMailbox[] }>("/api/mailboxes");
}

/**
 * Subscription-auth lanes (T48–T50). Mirrors AgentsView's SUBSCRIPTION_AUTH
 * — a deliberate minimal re-read: AgentsView owns the Connect flow, this is
 * only the metadata needed to report lane status. Each lane's route answers
 * 404 while its SHIBA_* flag is off, which reads as "not configured".
 */
export interface ProviderAuthLane {
  id: "claude-subscription" | "codex-subscription" | "antigravity-subscription";
  apiBase: string;
  /** The wrangler var that turns the lane on. */
  flag: string;
  label: string;
  blurb: string;
  /** Where the underlying credential lives (display only). */
  credentialLabel: string;
}

export const PROVIDER_AUTH_LANES: ProviderAuthLane[] = [
  {
    id: "claude-subscription",
    apiBase: "/api/auth/claude-subscription",
    flag: "SHIBA_CLAUDE_SUBSCRIPTION",
    label: "Claude",
    blurb: "Claude Pro/Max subscription — setup token held as a Worker secret.",
    credentialLabel: "CLAUDE_SUBSCRIPTION_TOKEN",
  },
  {
    id: "codex-subscription",
    apiBase: "/api/auth/codex-subscription",
    flag: "SHIBA_CODEX_SUBSCRIPTION",
    label: "Codex",
    blurb: "ChatGPT subscription — Codex auth.json held as a Worker secret.",
    credentialLabel: "CODEX_SUBSCRIPTION_AUTH_JSON",
  },
  {
    id: "antigravity-subscription",
    apiBase: "/api/auth/antigravity-subscription",
    flag: "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
    label: "Antigravity",
    blurb: "Google account sign-in — OAuth runs inside the auth sandbox.",
    credentialLabel: "Google sign-in (in-container OAuth)",
  },
];

export type ProviderAuthState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "error"; message: string }
  | { kind: "snapshot"; snapshot: AuthSnapshot };

/**
 * `GET /api/auth/<provider>` — the auth flow snapshot for one subscription
 * lane. A 404 means the SHIBA_* flag is off (route dark); that maps to
 * `unavailable`, not an error.
 */
export function useProviderAuth(apiBase: string): { state: ProviderAuthState; reload: () => void } {
  const [state, setState] = useState<ProviderAuthState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetch(`${apiBase}?account=default`)
      .then(async (response) => {
        if (response.status === 404) {
          if (!cancelled) setState({ kind: "unavailable" });
          return;
        }
        if (!response.ok) throw new Error(`GET ${apiBase} failed: ${response.status}`);
        const body = (await response.json().catch(() => ({}))) as { snapshot?: AuthSnapshot };
        if (!cancelled) {
          setState(
            body.snapshot !== undefined
              ? { kind: "snapshot", snapshot: body.snapshot }
              : { kind: "unavailable" },
          );
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [apiBase, attempt]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { state, reload };
}

/** Human label for a subscription-auth flow phase. */
export function authPhaseLabel(state: ProviderAuthState): string {
  if (state.kind === "loading") return "Checking…";
  if (state.kind === "unavailable") return "Not configured";
  if (state.kind === "error") return "Status error";
  switch (state.snapshot.phase) {
    case "succeeded":
      return "Connected";
    case "failed":
      return "Auth failed";
    case "waiting":
      return "Sign-in pending";
    case "starting":
    case "verifying":
      return "Connecting";
    case "idle":
    case "cleared":
    default:
      return "Not connected";
  }
}

/** Chip tone for a subscription-auth state (ToneChip palette keys). */
export function authPhaseTone(
  state: ProviderAuthState,
): "ok" | "danger" | "pending" | "navy" | "neutral" {
  if (state.kind === "error") return "danger";
  if (state.kind !== "snapshot") return "neutral";
  switch (state.snapshot.phase) {
    case "succeeded":
      return "ok";
    case "failed":
      return "danger";
    case "waiting":
      return "pending";
    case "starting":
    case "verifying":
      return "navy";
    default:
      return "neutral";
  }
}

/**
 * Wire shape of `GET /api/usage` — daily aggregates over the retained run
 * store plus the deployment's optional daily budget. Every token/cost field
 * is optional: the backend only reports what harnesses emitted, so an
 * absent field means "not reported", not zero.
 */
export interface UsageGroupWire {
  harness: string | null;
  provider: string | null;
  role: string | null;
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface UsageDayWire {
  date: string;
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  groups: UsageGroupWire[];
}

export interface UsageReportWire {
  generatedAt: number;
  timezone: string;
  budgetUsd: number | null;
  days: UsageDayWire[];
}

export function useUsageReport(
  sessionId: string,
  sessionApiAvailable: boolean,
): { state: LoadState<UsageReportWire>; reload: () => void } {
  const path = sessionApiAvailable
    ? `/api/usage?session=${encodeURIComponent(sessionId)}`
    : "/api/usage";
  return useApiJson<UsageReportWire>(path);
}
