/**
 * Live deployment status reads shared by the Integrations, Settings, and
 * Analytics surfaces. Every hook settles to an explicit state — data, an
 * error, or "route dark" — so a panel reports what the deployment proves
 * and never renders optimistic state.
 */

import type { AuthSnapshot } from "@shiba/shared";
import { useCallback, useEffect, useState } from "react";
import type { AgentPrincipal, InboxMailbox } from "./types";

/** Wire shape of `GET /api/setup/status` (backend `setup-status.ts`). Booleans only. */
export interface SetupStatus {
  slack: { signingSecret: boolean; botToken: boolean; approvers: number; channelRepos: boolean };
  github: { token: boolean; webhookSecret: boolean };
  gateway: { id: string; token: boolean; reachable: "yes" | "unauthorized" | "error" | "unknown" };
  access: { required: boolean };
  betterAuth: { configured: boolean };
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
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          });
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

export function useMailboxes(): {
  state: LoadState<{ mailboxes: InboxMailbox[] }>;
  reload: () => void;
} {
  return useApiJson<{ mailboxes: InboxMailbox[] }>("/api/mailboxes");
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

// ---------------------------------------------------------------------------
// Model config (Project 4 — purpose-aware model routing) + spine (P9)
// ---------------------------------------------------------------------------

/** Wire shape of one `connections[]` entry — the ModelConfig DO's record. */
export interface ModelConnectionWire {
  id: string;
  service: string;
  displayName: string;
  status: "unconfigured" | "ready" | "invalid" | "disabled";
  credentialRef: string | null;
}

/** Wire shape of the purpose policy — purpose → Workers AI model id. */
export interface PurposePolicyWire {
  version: number;
  models: Partial<Record<string, string>>;
  updatedAt: number;
}

export interface ModelConfigWire {
  connections: ModelConnectionWire[];
  policy: PurposePolicyWire;
  purposes: string[];
}

export function useModelConfig(): { state: LoadState<ModelConfigWire>; reload: () => void } {
  return useApiJson<ModelConfigWire>("/api/model-config");
}

/** One spine event — the orchestrator's durable decision record (P9). */
export interface SpineEventWire {
  seq: number;
  at: number;
  commandId: string;
  causationId?: string;
  kind: string;
  runId?: string;
  approvalId?: string;
  payload?: Record<string, unknown>;
}

/** One outbox row — a side effect the orchestrator owes. */
export interface OutboxEntryWire {
  id: string;
  effectKind: string;
  target: string;
  summary?: string;
  status: "pending" | "dispatched" | "failed";
  attempts: number;
  requestedAt?: number;
  requestedBy?: string;
  runId?: string;
  lastError?: string;
}

export interface SpineWire {
  events: SpineEventWire[];
  outbox: OutboxEntryWire[];
}

export function useSpine(
  sessionId: string,
  sessionApiAvailable: boolean,
): { state: LoadState<SpineWire>; reload: () => void } {
  const path = sessionApiAvailable
    ? `/api/spine?session=${encodeURIComponent(sessionId)}`
    : "/api/spine";
  return useApiJson<SpineWire>(path);
}
