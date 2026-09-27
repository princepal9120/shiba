/**
 * Scoped command executor + deterministic verify (PLAN.md §18.6/T45,
 * extending T43's verify gate).
 *
 * The executor enforces a per-harness argv allowlist Worker-side, before a
 * command ever reaches the sandbox exec endpoint. It scopes only the
 * caller-declared verify commands (`CodingTaskInput.verifyCommands`,
 * approval-gated like the rest of the envelope) — the runtime's own
 * plumbing execs (clone, git status/diff, the harness launch) are fixed
 * argv and bypass it by construction.
 *
 * A refusal never reaches exec, is recorded as a receipt, and fails the
 * verify — not the run.
 */
import { boundTail, redactSecrets, shellJoin } from "./security.js";
// Types only — a value import of opencode-input would pull in
// model-connections → harness/index and cycle the registry.
import type { CodingTaskInput, CodingTaskResult } from "./opencode-input.js";
import type {
  AgentHarness,
  ExecReceipt,
  VerificationCheck,
  VerificationOutcome,
  VerifyContext,
} from "./harness/types.js";

/** Per-command ceiling; enforced here so a stubbed/ignored ops timeout can't hang a run. */
const VERIFY_COMMAND_TIMEOUT_MS = 120_000;
/** Per-command output bound — a test suite's tail, not its history. */
export const VERIFY_OUTPUT_CAP_CHARS = 8_000;

/** Command matched no allowlist prefix — thrown before exec is ever called. */
export class ExecRefusedError extends Error {
  readonly argv: readonly string[];
  constructor(argv: readonly string[]) {
    super(`Command refused by the scoped executor: ${shellJoin([...argv])}`);
    this.name = "ExecRefusedError";
    this.argv = argv;
  }
}

/** An allowlisted command outlived its timeout. */
export class ExecTimeoutError extends Error {
  readonly argv: readonly string[];
  constructor(argv: readonly string[], timeoutMs: number) {
    super(`Command timed out after ${timeoutMs}ms: ${shellJoin([...argv])}`);
    this.name = "ExecTimeoutError";
    this.argv = argv;
  }
}

function argvAllowed(argv: readonly string[], allowlist: readonly (readonly string[])[]): boolean {
  return allowlist.some(
    (prefix) => argv.length >= prefix.length && prefix.every((part, i) => argv[i] === part),
  );
}

export interface ScopedExec {
  /**
   * Run argv if it matches the allowlist; otherwise throw ExecRefusedError
   * without touching the sandbox. Every outcome lands in `receipts`, in
   * order. Timeout throws ExecTimeoutError — enforced locally, not only by
   * the exec implementation.
   */
  run(argv: readonly string[], opts?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  readonly receipts: readonly ExecReceipt[];
}

export function createScopedExec(
  exec: VerifyContext["ops"]["exec"],
  allowlist: readonly (readonly string[])[],
  opts: { onReceipt?: (receipt: ExecReceipt) => void | Promise<void> } = {},
): ScopedExec {
  const receipts: ExecReceipt[] = [];
  const record = async (receipt: ExecReceipt): Promise<void> => {
    receipts.push(receipt);
    await opts.onReceipt?.(receipt);
  };
  return {
    receipts,
    async run(argv, runOpts = {}) {
      const started = Date.now();
      if (!argvAllowed(argv, allowlist)) {
        await record({ argv, outcome: "refused", durationMs: 0, outputTail: "" });
        throw new ExecRefusedError(argv);
      }
      const timeoutMs = runOpts.timeoutMs ?? VERIFY_COMMAND_TIMEOUT_MS;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          exec(shellJoin([...argv]), { cwd: runOpts.cwd, timeoutMs, signal: runOpts.signal }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new ExecTimeoutError(argv, timeoutMs)), timeoutMs);
          }),
        ]);
        const capped = {
          stdout: boundTail(result.stdout, VERIFY_OUTPUT_CAP_CHARS),
          stderr: boundTail(result.stderr, VERIFY_OUTPUT_CAP_CHARS),
          exitCode: result.exitCode,
        };
        await record({
          argv,
          outcome: "exited",
          exitCode: capped.exitCode,
          durationMs: Date.now() - started,
          outputTail: redactSecrets(`${capped.stdout}\n${capped.stderr}`.trim()),
        });
        return capped;
      } catch (error) {
        if (error instanceof ExecTimeoutError) {
          await record({ argv, outcome: "timeout", durationMs: Date.now() - started, outputTail: "" });
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

/**
 * The deterministic verify shared by every adapter (the interface keeps a
 * method so a harness *can* override; the default is this). Checks, in
 * order: clean exit, a captured diff, then each declared verifyCommands
 * entry through the scoped executor — refusal counts as a failed check.
 * Without a VerifyContext (no exec surface) commands are skipped and the
 * check is diff-only, matching the pre-T45 gate.
 */
export async function verifyRun(
  harness: AgentHarness,
  input: CodingTaskInput,
  result: CodingTaskResult,
  ctx?: VerifyContext,
): Promise<VerificationOutcome> {
  if (result.status !== "completed") return { ok: true };
  const hasDiff = result.changedFiles.length > 0 || result.diff.trim() !== "";
  const commands = input.verifyCommands ?? [];
  // No declared commands (or no exec surface): the T43 diff-only gate,
  // verdict shape unchanged.
  if (commands.length === 0 || ctx === undefined) {
    if (!hasDiff) {
      return {
        ok: false,
        reason: "Run exited 0 but produced no file changes — refusing to report a no-op as completed.",
      };
    }
    return { ok: true };
  }
  const checks: VerificationCheck[] = [
    { name: "exit", ok: result.exitCode === 0, detail: `exit ${result.exitCode}` },
    { name: "diff", ok: hasDiff, detail: `${result.changedFiles.length} file(s)` },
  ];
  const allowlist = harness.capabilities(input.codingModel).execAllowlist;
  const scoped = createScopedExec((command, runOpts) => ctx.ops.exec(command, runOpts), allowlist, {
    onReceipt: ctx.onReceipt,
  });
  for (const argv of commands) {
    const label = `command:${argv.join(" ")}`;
    try {
      const outcome = await scoped.run(argv, { cwd: ctx.workdir, signal: ctx.signal });
      checks.push({ name: label, ok: outcome.exitCode === 0, detail: `exit ${outcome.exitCode}` });
    } catch (error) {
      checks.push({ name: label, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      reason: `failed checks: ${failed.map((check) => check.name).join(", ")}`,
      checks,
    };
  }
  return { ok: true, checks };
}
