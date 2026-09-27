/**
 * T31 — mid-run steering with the approval gate and cancellation intact.
 *
 * A steering message targets an active (non-terminal: pending or running) run.
 *
 * Critical invariant (audit requirement):
 * The one-shot container harness does not consume mid-flight messages.
 * Therefore, any steering request MUST:
 *  1. Cancel and fence the live-running work (aborting container execution and bumping generation
 *     so late child writes are dropped).
 *  2. Re-freeze the effective input (original task + steering message + any overrides) as a NEW
 *     pending approval.
 *  3. Require a full new human approval before any new work can start.
 *
 * Steering is NEVER an unapproved text append or an approval bypass — the
 * invariant pinned in `test/steering.test.ts`.
 */
import {
  createPendingApproval,
  isApprovalExpired,
  isActiveStatus,
  normalizeRun,
  planSteering,
  parseSteeringInput,
  steeringThreadKey,
  MAX_STEERING_NOTES,
  MAX_PENDING_STEERS_PER_RUN,
  MAX_PENDING_APPROVALS,
  MAX_STEER_MESSAGE,
} from "@shiba/shared";
import type {
  ApprovedRoute,
  DelegatedRun,
  PendingApproval,
  SteeringNote,
} from "@shiba/shared";
import { appendReceipt, makeReceipt } from "./receipts.js";
import { parseGitHubRepoUrl } from "./security.js";

export {
  MAX_STEER_MESSAGE,
  MAX_STEERING_NOTES,
  MAX_PENDING_STEERS_PER_RUN,
  MAX_PENDING_APPROVALS,
  parseSteeringInput,
  planSteering,
  runIdFromSteeringThreadKey,
  steeringThreadKey,
  steerRunInputSchema,
} from "@shiba/shared";
export type {
  SteeringAction,
  SteeringInput,
  SteeringNote,
  SteeringParseResult,
  SteeringPlan,
  SteerRunInput,
} from "@shiba/shared";

/** Record a steer note on the run; receipt mirrors it for the audit log. */
export function appendSteeringNote(run: DelegatedRun, note: SteeringNote): DelegatedRun {
  const steering = [...(run.steering ?? []), note];
  const bounded =
    steering.length <= MAX_STEERING_NOTES
      ? steering
      : steering.slice(steering.length - MAX_STEERING_NOTES);
  const label =
    note.kind === "approval"
      ? `Steering follow-up escalated to approval ${note.approvalId ?? ""}`.trim()
      : `Steering follow-up queued: ${note.message.slice(0, 120)}`;
  return {
    ...normalizeRun(run),
    steering: bounded,
    receipts: appendReceipt(run.receipts, makeReceipt("triage", label, note.at)),
    updatedAt: note.at,
  };
}

export interface SteeringHost {
  listRuns(): DelegatedRun[];
  writeRuns(runs: DelegatedRun[]): void;
  listApprovals(): PendingApproval[];
  writeApprovals(approvals: PendingApproval[]): void;
  cancelRun(runId: string): Promise<DelegatedRun | null> | DelegatedRun | null;
  /**
   * Re-resolve a route when the steer changes harness/model/connection —
   * the host must freeze its own resolved route, never a client-supplied
   * one. Rejects like queueSlackRun's resolveRoute when inadmissible.
   */
  resolveRoute?(input: {
    repoUrl: string;
    task: string;
    baseBranch: string;
    publishPullRequest: boolean;
    harness?: string;
    codingModel?: string;
    connectionId?: string;
  }): Promise<{ route: ApprovedRoute }>;
  githubTokenConfigured?: boolean;
  now?(): number;
}

/**
 * Apply a steering request against host state.
 *
 * Validates the run is live and visible to the caller, cancels/fences the live
 * run, and mints a pending approval that re-freezes the effective input.
 * Nothing executes on steer alone: the existing POST /api/approvals resolve path
 * is the only way the re-frozen input becomes a run.
 */
export async function handleSteeringRequest(
  host: SteeringHost,
  runId: string,
  body: unknown,
  opts?: { steeredBy?: string },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const now = host.now?.() ?? Date.now();
  const parsed = parseSteeringInput(body);
  if (!parsed.ok) {
    return { status: parsed.status, body: { error: parsed.error } };
  }
  const input = parsed.input;
  const runs = host.listRuns().map(normalizeRun);
  const run = runs.find((candidate) => candidate.runId === runId);
  if (!run || (opts?.steeredBy !== undefined && run.queuedBy !== opts.steeredBy)) {
    return { status: 404, body: { error: "Run not found." } };
  }
  if (!isActiveStatus(run.status)) {
    return {
      status: 409,
      body: { error: `Run "${runId}" is ${run.status} — only pending or running runs accept steering.` },
    };
  }

  const floodCheck = (): { status: number; body: Record<string, unknown> } | null => {
    const approvals = host.listApprovals();
    const live = approvals.filter(
      (approval) => approval.status === "pending" && !isApprovalExpired(approval, now),
    );
    // Per-run cap counts only THIS run's steering approvals — a steer
    // storm on another run must not starve this one.
    // Steering mints real approval records, so the intake-wide pending
    // ceiling applies here too — a steer loop must not bypass MAX_PENDING.
    if (live.length >= MAX_PENDING_APPROVALS) {
      return { status: 429, body: { error: "Too many pending approvals — resolve some first." } };
    }
    const pendingSteers = live.filter(
      (approval) => approval.threadKey === steeringThreadKey(runId),
    ).length;
    if (pendingSteers >= MAX_PENDING_STEERS_PER_RUN) {
      return { status: 429, body: { error: "Too many pending steering approvals — resolve them first." } };
    }
    return null;
  };
  const flood = floodCheck();
  if (flood) return flood;

  const plan = planSteering(run, input);
  try {
    parseGitHubRepoUrl(plan.effective.repoUrl);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : "Invalid repository URL." } };
  }
  if (plan.effective.publishPullRequest && host.githubTokenConfigured === false) {
    return { status: 400, body: { error: "publishPullRequest was requested but GITHUB_TOKEN is not configured." } };
  }
  const combinedTask = plan.effective.task;
  if (combinedTask.length > MAX_STEER_MESSAGE) {
    return { status: 400, body: { error: `Combined task and steering message must be at most ${MAX_STEER_MESSAGE} characters.` } };
  }
  // Re-resolve only when the steer ACTUALLY changes a route field —
  // changedFields already compares each override to the frozen route, so
  // repeating the approved values reuses run.route verbatim instead of
  // round-tripping through (possibly absent) host resolution.
  const routeChanged = plan.changedFields.some(
    (field) => field === "harness" || field === "codingModel" || field === "connectionId",
  );
  let route: ApprovedRoute | undefined;
  if (routeChanged) {
    if (!host.resolveRoute) {
      return { status: 400, body: { error: "This host cannot re-resolve a changed route; steering refused." } };
    }
    try {
      // Partial override preservation: unspecified route fields fall back
      // to the frozen route on the run, never to deployment defaults.
      const resolved = await host.resolveRoute({
        repoUrl: plan.effective.repoUrl,
        task: plan.effective.task,
        baseBranch: plan.effective.baseBranch,
        publishPullRequest: plan.effective.publishPullRequest,
        harness: input.harness ?? run.route?.harness,
        codingModel: input.codingModel ?? run.route?.modelId,
        connectionId: input.connectionId ?? run.route?.connectionId ?? undefined,
      });
      route = resolved.route;
    } catch (error) {
      return {
        status: 400,
        body: { error: error instanceof Error ? error.message : "Unsupported model route." },
      };
    }
  } else if (run.route !== undefined) {
    route = run.route;
  }

  // Async re-check: route resolution yielded, so the run may have gone
  // terminal (or the approval board filled) while we waited. Re-read
  // before cancelling.
  const latest = host.listRuns().map(normalizeRun).find((candidate) => candidate.runId === runId);
  if (!latest || !isActiveStatus(latest.status)) {
    return { status: 409, body: { error: "Run is no longer active for steering." } };
  }
  const floodAfter = floodCheck();
  if (floodAfter) return floodAfter;

  // Critical: cancel and fence the live-running work before work starts.
  // Never append text only as if the one-shot harness consumes it.
  const cancelled = await host.cancelRun(runId);
  if (!cancelled || cancelled.status !== "cancelled") {
    return { status: 409, body: { error: "Could not cancel live run for steering." } };
  }

  const approvalId = crypto.randomUUID();
  const by = opts?.steeredBy?.slice(0, 200);

  try {
    host.writeApprovals(
      createPendingApproval(host.listApprovals(), {
        threadKey: steeringThreadKey(runId),
        approvalId,
        repoUrl: plan.effective.repoUrl,
        task: plan.effective.task,
        baseBranch: plan.effective.baseBranch,
        publishPullRequest: plan.effective.publishPullRequest,
        ...(route !== undefined ? { route } : {}),
        ...(by !== undefined ? { queuedBy: by } : run.queuedBy !== undefined ? { queuedBy: run.queuedBy } : {}),
        createdAt: now,
      }),
    );
  } catch (error) {
    return {
      status: 409,
      body: { error: error instanceof Error ? error.message : "Could not queue approval." },
    };
  }

  // Record escalation on the cancelled run
  const noted = appendSteeringNote(cancelled, {
    at: now,
    message: input.message,
    kind: "approval",
    approvalId,
    ...(by !== undefined ? { by } : {}),
  });
  const currentRuns = host.listRuns().map(normalizeRun);
  host.writeRuns(currentRuns.map((candidate) => (candidate.runId === runId ? noted : candidate)));

  return {
    status: 202,
    body: {
      ok: true,
      action: "reapproval",
      runId,
      approvalId,
      changedFields: plan.changedFields,
    },
  };
}
