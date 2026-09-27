/**
 * Pure run-lifecycle decider (PLAN.md §18.1, T40). Transition legality is a
 * pure function of the run record, the approval pointer, and the command —
 * no Worker, Durable Object, container, clock, or RNG. `runs.ts` wraps it so
 * existing call sites stay thin; the orchestrator DO remains the only writer.
 *
 * The machine it owns: pending → running → completed | error | aborted |
 * cancelled | unknown. Terminal records are immutable. Every transition emits
 * a typed event; a replayed intent command (queue/start/approve/cancel)
 * returns the already-recorded outcome flagged `replayed` instead of a second
 * mutation. Terminal commands (finish/fail/abort/reclaim) on a terminal run
 * are errors — the store's generation fencing is what drops late writes, so a
 * terminal refusal surfaces as an error, not a silent accept.
 *
 * Approval-gate legality: a run may not enter `running` without
 * `ApprovalEvidence` that matches the stored pointer's approver and the
 * input hash of the run's frozen fields. Evidence attaches at queue (the
 * approval-resolve path) or via `approve`; `start` re-asserts it.
 */
import type { ApprovalEvidence, PendingApproval, RunInputFields } from "./approvals.js";
import { runInputHash } from "./approvals.js";
import type { ApprovedRoute } from "./model.js";
import { MAX_RECEIPTS } from "./receipts.js";
import type { Receipt, ReceiptKind } from "./receipts.js";
import type { RunErrorCode } from "./run-errors.js";
import { terminalStatusForError } from "./run-errors.js";
import type { DelegatedRun, RunPatch } from "./runs.js";
import { isActiveStatus, isTerminalStatus, normalizeRun } from "./runs.js";

/** The creation payload a `queue` command carries — createRun's args. */
export interface QueuedRunInput {
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  queuedBy?: string;
  route?: ApprovedRoute;
}

export type RunCommand =
  | { type: "queue"; commandId: string; runId: string; input: QueuedRunInput; approval?: ApprovalEvidence; at: number }
  | { type: "approve"; commandId: string; runId: string; approval: ApprovalEvidence; at: number }
  | { type: "start"; commandId: string; runId: string; approvalEvidence?: ApprovalEvidence; at: number }
  | { type: "finish"; commandId: string; runId: string; patch: RunPatch; at: number }
  | { type: "fail"; commandId: string; runId: string; patch: RunPatch & { errorCode: RunErrorCode }; at: number }
  | { type: "abort"; commandId: string; runId: string; reason: string; patch?: RunPatch; at: number }
  | { type: "cancel"; commandId: string; runId: string; patch?: RunPatch; at: number }
  | { type: "reclaim"; commandId: string; runId: string; deadlineMs: number; at: number };

export type RunEvent =
  | { type: "run.queued"; commandId: string; at: number; run: DelegatedRun; replayed?: boolean }
  | { type: "run.approved"; commandId: string; at: number; approval: ApprovalEvidence; replayed?: boolean }
  | { type: "run.started"; commandId: string; at: number; approval?: ApprovalEvidence; replayed?: boolean }
  | { type: "run.completed"; commandId: string; at: number; patch: RunPatch; replayed?: boolean }
  | { type: "run.failed"; commandId: string; at: number; status: "error" | "unknown"; patch: RunPatch; replayed?: boolean }
  | { type: "run.aborted"; commandId: string; at: number; patch: RunPatch; replayed?: boolean }
  | { type: "run.cancelled"; commandId: string; at: number; patch?: RunPatch; replayed?: boolean }
  | { type: "run.reclaimed"; commandId: string; at: number; patch: RunPatch; replayed?: boolean };

export type RunTransitionErrorCode =
  | "run_exists"
  | "run_not_found"
  | "input_conflict"
  | "terminal"
  | "illegal_transition"
  | "approval_required"
  | "approval_mismatch"
  | "not_stale";

export interface RunTransitionError {
  code: RunTransitionErrorCode;
  message: string;
}

export type RunDecision = { events: RunEvent[] } | { error: RunTransitionError };

/**
 * What the decider sees: the run row plus the approval pointer that
 * authorizes it, when the caller can supply one. A `start` can stand on
 * stored evidence alone (the pointer is only needed to *attach* evidence),
 * but a supplied pointer that no longer reads `approved` refuses the start.
 */
export interface RunMachineState {
  run: DelegatedRun | null;
  approval?: Pick<PendingApproval, "approvalId" | "status" | "decidedBy"> | null;
}

function rejected(code: RunTransitionErrorCode, message: string): RunDecision {
  return { error: { code, message } };
}

function evidenceMatches(a: ApprovalEvidence, b: ApprovalEvidence): boolean {
  return (
    a.approvalId === b.approvalId &&
    a.decidedBy === b.decidedBy &&
    a.decidedAt === b.decidedAt &&
    a.inputHash === b.inputHash
  );
}

/** Evidence may stamp a run iff its hash covers the run's frozen input. */
function hashMatchesRun(evidence: ApprovalEvidence, run: RunInputFields): boolean {
  return (
    evidence.inputHash ===
    runInputHash({
      repoUrl: run.repoUrl,
      task: run.task,
      baseBranch: run.baseBranch,
      publishPullRequest: run.publishPullRequest,
      ...(run.route !== undefined ? { route: run.route } : {}),
    })
  );
}

/** The pointer, when supplied, must still read approved for the same approval id. */
function pointerApproves(state: RunMachineState, approvalId: string): boolean {
  return (
    state.approval === undefined ||
    state.approval === null ||
    (state.approval.approvalId === approvalId && state.approval.status === "approved")
  );
}

export function decideRunTransition(state: RunMachineState, command: RunCommand): RunDecision {
  const run = state.run === null ? null : normalizeRun(state.run);
  const at = command.at;

  switch (command.type) {
    case "queue": {
      if (run === null) {
        const approval = command.approval;
        if (approval !== undefined && !hashMatchesRun(approval, command.input)) {
          return rejected("approval_mismatch", `Approval evidence for ${command.runId} does not cover the queued input.`);
        }
        const queued: DelegatedRun = {
          runId: command.runId,
          sandboxId: command.input.sandboxId,
          repoUrl: command.input.repoUrl,
          task: command.input.task,
          baseBranch: command.input.baseBranch,
          publishPullRequest: command.input.publishPullRequest,
          ...(command.input.queuedBy !== undefined ? { queuedBy: command.input.queuedBy } : {}),
          ...(command.input.route !== undefined ? { route: command.input.route } : {}),
          ...(approval !== undefined ? { approval } : {}),
          status: "pending",
          generation: 0,
          createdAt: at,
          updatedAt: at,
        };
        return { events: [{ type: "run.queued", commandId: command.commandId, at, run: queued }] };
      }
      if (run.runId === command.runId) {
        const sameInput =
          run.repoUrl === command.input.repoUrl &&
          run.task === command.input.task &&
          run.baseBranch === command.input.baseBranch &&
          run.publishPullRequest === command.input.publishPullRequest;
        if (sameInput) {
          return { events: [{ type: "run.queued", commandId: command.commandId, at, run, replayed: true }] };
        }
        return rejected("input_conflict", `Run ${command.runId} already exists with a different input.`);
      }
      return rejected("run_exists", `Cannot queue ${command.runId}: run ${run.runId} occupies this machine.`);
    }

    case "approve": {
      if (run === null) return rejected("run_not_found", `Cannot approve missing run ${command.runId}.`);
      if (isTerminalStatus(run.status)) return rejected("terminal", `Run ${run.runId} is ${run.status}.`);
      if (run.status !== "pending") return rejected("illegal_transition", `Run ${run.runId} is ${run.status}, not pending.`);
      if (state.approval !== undefined && state.approval !== null) {
        const pointer = state.approval;
        if (pointer.approvalId !== command.approval.approvalId) {
          return rejected("approval_mismatch", `Evidence names ${command.approval.approvalId}; pointer is ${pointer.approvalId}.`);
        }
        if (pointer.status !== "approved") {
          return rejected("approval_required", `Approval ${pointer.approvalId} is ${pointer.status}, not approved.`);
        }
        if (pointer.decidedBy !== undefined && pointer.decidedBy !== command.approval.decidedBy) {
          return rejected("approval_mismatch", `Evidence names approver ${command.approval.decidedBy}; pointer says ${pointer.decidedBy}.`);
        }
      }
      if (!hashMatchesRun(command.approval, run)) {
        return rejected("approval_mismatch", `Approval evidence for ${run.runId} does not cover the run's frozen input.`);
      }
      if (run.approval !== undefined) {
        if (evidenceMatches(run.approval, command.approval)) {
          return { events: [{ type: "run.approved", commandId: command.commandId, at, approval: run.approval, replayed: true }] };
        }
        return rejected("approval_mismatch", `Run ${run.runId} already carries different approval evidence.`);
      }
      return { events: [{ type: "run.approved", commandId: command.commandId, at, approval: command.approval }] };
    }

    case "start": {
      if (run === null) return rejected("run_not_found", `Cannot start missing run ${command.runId}.`);
      // Evidence comes from the command's assertion, falling back to what
      // the run already carries — either way one must exist to start.
      const evidence = command.approvalEvidence ?? run.approval;
      const stored = run.approval;
      if (evidence === undefined) {
        return rejected("approval_required", `Run ${run.runId} carries no approval evidence.`);
      }
      if (run.status === "running") {
        if (stored !== undefined && evidenceMatches(stored, evidence) && pointerApproves(state, evidence.approvalId)) {
          return { events: [{ type: "run.started", commandId: command.commandId, at, replayed: true }] };
        }
        return rejected("illegal_transition", `Run ${run.runId} is already running under different evidence.`);
      }
      if (isTerminalStatus(run.status)) return rejected("terminal", `Run ${run.runId} is ${run.status}.`);
      if (run.status !== "pending") return rejected("illegal_transition", `Run ${run.runId} is ${run.status}, not pending.`);
      // The gate: evidence must cover the run's frozen input and, when the
      // pointer is supplied, still read approved for the same approvalId.
      if (!hashMatchesRun(evidence, run)) {
        return rejected("approval_mismatch", `Start evidence for ${run.runId} does not cover the run's frozen input.`);
      }
      if (stored !== undefined && !evidenceMatches(stored, evidence)) {
        return rejected("approval_mismatch", `Start evidence disagrees with the evidence stored on run ${run.runId}.`);
      }
      if (stored === undefined) {
        if (state.approval === undefined || state.approval === null) {
          return rejected("approval_required", `Run ${run.runId} carries no approval evidence and no pointer was supplied.`);
        }
        if (state.approval.approvalId !== evidence.approvalId || state.approval.status !== "approved") {
          return rejected("approval_required", `No approved pointer ${evidence.approvalId} authorizes run ${run.runId}.`);
        }
      }
      if (!pointerApproves(state, evidence.approvalId)) {
        return rejected("approval_required", `Approval ${evidence.approvalId} no longer reads approved.`);
      }
      return {
        events: [{
          type: "run.started",
          commandId: command.commandId,
          at,
          // A pointer-only authorization stamps the evidence onto the run so
          // later checks (reclaim, replayed starts) don't re-need it.
          ...(run.approval === undefined ? { approval: evidence } : {}),
        }],
      };
    }

    case "finish": {
      if (run === null) return rejected("run_not_found", `Cannot finish missing run ${command.runId}.`);
      if (isTerminalStatus(run.status)) return rejected("terminal", `Run ${run.runId} is already ${run.status}.`);
      if (run.status !== "running") return rejected("illegal_transition", `Run ${run.runId} is ${run.status}; only a running run can complete.`);
      return { events: [{ type: "run.completed", commandId: command.commandId, at, patch: command.patch }] };
    }

    case "fail": {
      if (run === null) return rejected("run_not_found", `Cannot fail missing run ${command.runId}.`);
      if (isTerminalStatus(run.status)) return rejected("terminal", `Run ${run.runId} is already ${run.status}.`);
      const status = terminalStatusForError(command.patch.errorCode);
      if (status === "cancelled") {
        return { events: [{ type: "run.cancelled", commandId: command.commandId, at, patch: command.patch }] };
      }
      return { events: [{ type: "run.failed", commandId: command.commandId, at, status, patch: command.patch }] };
    }

    case "abort": {
      if (run === null) return rejected("run_not_found", `Cannot abort missing run ${command.runId}.`);
      if (isTerminalStatus(run.status)) return rejected("terminal", `Run ${run.runId} is already ${run.status}.`);
      return {
        events: [
          {
            type: "run.aborted",
            commandId: command.commandId,
            at,
            patch: { ...command.patch, error: command.reason },
          },
        ],
      };
    }

    case "cancel": {
      if (run === null) return rejected("run_not_found", `Cannot cancel missing run ${command.runId}.`);
      if (!isActiveStatus(run.status)) {
        // Cancellation wins races but cannot rewrite history: a settled run
        // answers the replayed intent unchanged.
        return { events: [{ type: "run.cancelled", commandId: command.commandId, at, replayed: true }] };
      }
      return { events: [{ type: "run.cancelled", commandId: command.commandId, at, ...(command.patch !== undefined ? { patch: command.patch } : {}) }] };
    }

    case "reclaim": {
      if (run === null) return rejected("run_not_found", `Cannot reclaim missing run ${command.runId}.`);
      if (isTerminalStatus(run.status)) return rejected("terminal", `Run ${run.runId} is already ${run.status}.`);
      if (!isActiveStatus(run.status) || at - run.updatedAt <= command.deadlineMs) {
        return rejected("not_stale", `Run ${run.runId} has not exceeded its deadline.`);
      }
      return {
        events: [{
          type: "run.reclaimed",
          commandId: command.commandId,
          at,
          patch: {
            error: `Run exceeded its ${Math.round(command.deadlineMs / 60000)}-minute deadline and was reclaimed; side effects are unverified — it may have pushed or opened a PR.`,
            errorCode: "outcome_unknown",
          },
        }],
      };
    }
  }
}

/** Receipt-materializer seam: backend supplies the secret-redacting one. */
export type MakeReceipt = (kind: ReceiptKind, message: string, at: number) => Receipt;

function pushReceipt(run: DelegatedRun, kind: ReceiptKind, message: string, at: number, make: MakeReceipt): void {
  const next = [...(run.receipts ?? []), make(kind, message, at)];
  run.receipts = next.length <= MAX_RECEIPTS ? next : next.slice(next.length - MAX_RECEIPTS);
}

function applyPatch(run: DelegatedRun, patch: RunPatch | undefined): void {
  if (!patch) return;
  if (patch.summary !== undefined) run.summary = patch.summary;
  if (patch.error !== undefined) run.error = patch.error;
  if (patch.errorCode !== undefined) run.errorCode = patch.errorCode;
  if (patch.diff !== undefined) run.diff = patch.diff;
  if (patch.pullUrl !== undefined) run.pullUrl = patch.pullUrl;
  if (patch.screenshotUrl !== undefined) run.screenshotUrl = patch.screenshotUrl;
  if (patch.receipts !== undefined) run.receipts = patch.receipts;
  if (patch.sandboxId !== undefined) run.sandboxId = patch.sandboxId;
  if (patch.signals !== undefined) run.signals = patch.signals;
}

/**
 * The projector half: fold decided events into the next run record.
 * Receipt synthesis preserves the pre-decider wire exactly — init on queue,
 * submit on completed, error on failed/aborted/reclaimed, none on
 * started/approved/cancelled. `generation` bumps once per non-replayed event.
 * `make` is injected so the backend's redacting `makeReceipt` stays the only
 * receipt constructor and shared stays dependency-free.
 */
export function applyRunEvents(
  current: DelegatedRun | null,
  events: RunEvent[],
  make: MakeReceipt,
): DelegatedRun | null {
  let run = current === null ? null : normalizeRun({ ...current });
  for (const event of events) {
    if (event.replayed) continue;
    switch (event.type) {
      case "run.queued": {
        run = { ...event.run, receipts: event.run.receipts ?? [] };
        pushReceipt(run, "init", `Queued ${run.repoUrl} (${run.baseBranch}).`, event.at, make);
        break;
      }
      case "run.approved": {
        if (run === null) break;
        run.approval = event.approval;
        run.updatedAt = event.at;
        run.generation += 1;
        break;
      }
      case "run.started": {
        if (run === null) break;
        if (event.approval !== undefined) run.approval = event.approval;
        run.status = "running";
        run.updatedAt = event.at;
        run.generation += 1;
        break;
      }
      case "run.completed": {
        if (run === null) break;
        applyPatch(run, event.patch);
        run.status = "completed";
        run.updatedAt = event.at;
        run.generation += 1;
        pushReceipt(run, "submit", event.patch.error ?? event.patch.summary ?? "completed", event.at, make);
        break;
      }
      case "run.failed": {
        if (run === null) break;
        applyPatch(run, event.patch);
        run.status = event.status;
        run.updatedAt = event.at;
        run.generation += 1;
        pushReceipt(run, "error", event.patch.error ?? event.patch.summary ?? event.status, event.at, make);
        break;
      }
      case "run.aborted": {
        if (run === null) break;
        applyPatch(run, event.patch);
        run.status = "aborted";
        run.updatedAt = event.at;
        run.generation += 1;
        pushReceipt(run, "error", event.patch.error ?? event.patch.summary ?? "aborted", event.at, make);
        break;
      }
      case "run.cancelled": {
        if (run === null) break;
        applyPatch(run, event.patch);
        run.status = "cancelled";
        run.updatedAt = event.at;
        run.generation += 1;
        break;
      }
      case "run.reclaimed": {
        if (run === null) break;
        applyPatch(run, event.patch);
        run.status = "unknown";
        run.updatedAt = event.at;
        run.generation += 1;
        pushReceipt(run, "error", event.patch.error ?? "reclaimed", event.at, make);
        break;
      }
    }
  }
  return run;
}

/** Convenience: decide + apply in one call. Returns the next record or null on error. */
export function transitionRunViaDecider(
  state: RunMachineState,
  command: RunCommand,
  make: MakeReceipt,
): { run: DelegatedRun | null; decision: RunDecision } {
  const decision = decideRunTransition(state, command);
  if ("error" in decision) return { run: null, decision };
  return { run: applyRunEvents(state.run, decision.events, make), decision };
}
