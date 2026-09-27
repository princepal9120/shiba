/**
 * T42 typed runtime signals: a run emits ordered milestones as it moves
 * through the pipeline — persisted on the run row so a waiter reads the
 * signal it needs instead of ordering by convention (or, in tests,
 * sleeping on a timer). The DO is the serialization point, so signal
 * order on the record is the order they fired.
 */
export const RUN_SIGNAL_KINDS = [
  "sandbox.ready",
  "clone.complete",
  "config.written",
  "harness.started",
  "harness.idle",
  "collect.complete",
  // T45: every scoped exec invocation is receipted — command, exit, duration.
  "exec.invoked",
  "exec.settled",
  "pr.opened",
  "screenshot.captured",
] as const;

export type RunSignalKind = (typeof RUN_SIGNAL_KINDS)[number];

export interface RunSignal {
  kind: RunSignalKind;
  at: number;
  /** Small structured detail (config path, exit code, file count, PR url). */
  detail?: string;
}

/** The first signal of a kind, or undefined — presence is the waiter's answer. */
export function runSignal(
  signals: readonly RunSignal[] | undefined,
  kind: RunSignalKind,
): RunSignal | undefined {
  return signals?.find((signal) => signal.kind === kind);
}

export function hasRunSignal(
  signals: readonly RunSignal[] | undefined,
  kind: RunSignalKind,
): boolean {
  return runSignal(signals, kind) !== undefined;
}
