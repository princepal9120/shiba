/**
 * T31 — mid-run steering wire types and invariants.
 *
 * Wire types and pure contracts shared between @shiba/backend,
 * @shiba/frontend, and @shiba/web.
 */
import { z } from "zod";
import { HARNESS_IDS } from "./mcp.js";
import type { ApprovedRoute } from "./model.js";
import type { DelegatedRun } from "./runs.js";

/** Matches the task cap in the orchestrator's queueSlackRun. */
export const MAX_STEER_MESSAGE = 4000;
/** Pending steer notes retained per run — bounded like receipts. */
export const MAX_STEERING_NOTES = 32;
/**
 * Pending steering approvals per run. Steering mints real approval records
 * that live in DO state, so an unbounded steer loop is the same flood risk
 * the MAX_PENDING guard covers at intake.
 */
export const MAX_PENDING_STEERS_PER_RUN = 10;
/**
 * Global pending-approval ceiling — the same MAX_PENDING guard
 * queueSlackRun applies at intake. Steering mints real approval records,
 * so it must respect the same cap or a steer loop becomes a flood path
 * that bypasses intake.
 */
export const MAX_PENDING_APPROVALS = 100;

/** Thread-key namespace linking a steering approval to its source run. */
export function steeringThreadKey(runId: string): string {
  return `steer:${runId}`;
}

export function runIdFromSteeringThreadKey(threadKey: string): string | null {
  return threadKey.startsWith("steer:") ? threadKey.slice("steer:".length) : null;
}

/** Fields a steering body may carry; everything is optional but `message`. */
export interface SteeringInput {
  message: string;
  repoUrl?: string;
  baseBranch?: string;
  publishPullRequest?: boolean;
  harness?: string;
  codingModel?: string;
  connectionId?: string;
  /**
   * Caller-declared scope change. Text-only follow-ups cannot be classified
   * semantically, so a client that knows the follow-up widens scope marks it
   * here and gets the approval path even when no frozen field differs.
   */
  changesScope?: boolean;
}

export interface SteeringNote {
  at: number;
  message: string;
  /** "queued" = recorded on the run; "approval" = escalated to a pending approval. */
  kind: "queued" | "approval";
  approvalId?: string;
  by?: string;
}

export type SteeringParseResult =
  | { ok: true; input: SteeringInput }
  | { ok: false; status: number; error: string };

/** Validate an untyped JSON body the way queueSlackRun validates its input. */
export function parseSteeringInput(body: unknown): SteeringParseResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object." };
  }
  const raw = body as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) {
    return { ok: false, status: 400, error: "message is required." };
  }
  if (message.length > MAX_STEER_MESSAGE) {
    return { ok: false, status: 400, error: `message must be at most ${MAX_STEER_MESSAGE} characters.` };
  }
  const stringField = (name: string): { ok: true; value?: string } | { ok: false; status: number; error: string } => {
    const value = raw[name];
    if (value === undefined) return { ok: true };
    if (typeof value !== "string" || !value.trim()) {
      return { ok: false, status: 400, error: `${name} must be a non-empty string when provided.` };
    }
    return { ok: true, value: value.trim().slice(0, 200) };
  };
  const repoUrl = stringField("repoUrl");
  if (!repoUrl.ok) return repoUrl;
  const baseBranch = stringField("baseBranch");
  if (!baseBranch.ok) return baseBranch;
  const harness = stringField("harness");
  if (!harness.ok) return harness;
  // Only installed sandbox harnesses can ever run: the registry also carries
  // names whose CLIs are not installed, so a free-form harness must be a
  // member or the steer would cancel live work for an approval that can
  // never dispatch (same enum the queue schema uses).
  if (harness.value !== undefined && !(HARNESS_IDS as readonly string[]).includes(harness.value)) {
    return {
      ok: false,
      status: 400,
      error: `harness must be one of ${HARNESS_IDS.join(", ")}.`,
    };
  }
  const codingModel = stringField("codingModel");
  if (!codingModel.ok) return codingModel;
  const connectionId = stringField("connectionId");
  if (!connectionId.ok) return connectionId;
  if (raw.publishPullRequest !== undefined && typeof raw.publishPullRequest !== "boolean") {
    return { ok: false, status: 400, error: "publishPullRequest must be a boolean when provided." };
  }
  if (raw.changesScope !== undefined && typeof raw.changesScope !== "boolean") {
    return { ok: false, status: 400, error: "changesScope must be a boolean when provided." };
  }
  return {
    ok: true,
    input: {
      message,
      ...(repoUrl.value !== undefined ? { repoUrl: repoUrl.value } : {}),
      ...(baseBranch.value !== undefined ? { baseBranch: baseBranch.value } : {}),
      ...(raw.publishPullRequest !== undefined ? { publishPullRequest: raw.publishPullRequest as boolean } : {}),
      ...(harness.value !== undefined ? { harness: harness.value } : {}),
      ...(codingModel.value !== undefined ? { codingModel: codingModel.value } : {}),
      ...(connectionId.value !== undefined ? { connectionId: connectionId.value } : {}),
      ...(raw.changesScope === true ? { changesScope: true } : {}),
    },
  };
}

export type SteeringAction = "reapproval";

export interface SteeringPlan {
  action: SteeringAction;
  /** Frozen fields the steer tries to change. */
  changedFields: string[];
  /** Effective input a reapproval must freeze — run values + overrides. */
  effective: {
    repoUrl: string;
    task: string;
    baseBranch: string;
    publishPullRequest: boolean;
  };
}

/**
 * Plan a steering request.
 * Critical invariant: because the one-shot container harness does not consume
 * mid-flight messages, EVERY steer against an active run requires cancelling/fencing
 * live-running work and obtaining a full new approval before new work can execute.
 */
export function planSteering(run: DelegatedRun, input: SteeringInput): SteeringPlan {
  const changedFields: string[] = [];
  changedFields.push("task");
  if (input.repoUrl !== undefined && input.repoUrl !== run.repoUrl) {
    changedFields.push("repoUrl");
  }
  if (input.baseBranch !== undefined && input.baseBranch !== run.baseBranch) {
    changedFields.push("baseBranch");
  }
  if (input.publishPullRequest !== undefined && input.publishPullRequest !== run.publishPullRequest) {
    changedFields.push("publishPullRequest");
  }
  if (input.harness !== undefined && input.harness !== run.route?.harness) {
    changedFields.push("harness");
  }
  if (input.codingModel !== undefined && input.codingModel !== run.route?.modelId) {
    changedFields.push("codingModel");
  }
  if (input.connectionId !== undefined && input.connectionId !== (run.route?.connectionId ?? undefined)) {
    changedFields.push("connectionId");
  }
  if (input.changesScope === true && !changedFields.includes("changesScope")) {
    changedFields.push("changesScope");
  }
  const baseBranch = input.baseBranch ?? run.baseBranch;
  const repoUrl = input.repoUrl ?? run.repoUrl;
  const task = `${run.task}\n\n[steering follow-up]\n${input.message}`;
  return {
    action: "reapproval",
    changedFields,
    effective: {
      repoUrl,
      task,
      baseBranch,
      publishPullRequest: input.publishPullRequest ?? run.publishPullRequest,
    },
  };
}

export const steerRunInputSchema = z.object({
  runId: z.string().min(1).describe("Run id to steer."),
  message: z.string().min(1).max(MAX_STEER_MESSAGE).describe("Steering message / follow-up instructions."),
  repoUrl: z.string().optional().describe("Optional repoUrl override."),
  baseBranch: z.string().optional().describe("Optional baseBranch override."),
  publishPullRequest: z.boolean().optional().describe("Optional publishPullRequest override."),
  harness: z.enum(HARNESS_IDS).optional().describe("Optional harness override."),
  codingModel: z.string().optional().describe("Optional codingModel override."),
  connectionId: z.string().optional().describe("Optional connectionId override."),
  changesScope: z.boolean().optional().describe("Declare scope change."),
});

export type SteerRunInput = z.infer<typeof steerRunInputSchema>;
