/**
 * T45 — scoped command execution, not blanket bash (PLAN.md §18.6).
 *
 * Every command the Worker sends to the sandbox exec endpoint passes through
 * here: argv-prefix allowlist, per-command timeout, output cap, and a receipt
 * pair (exec.invoked / exec.settled signals) the run row persists so the exec
 * trail is inspectable.
 *
 * The allowlist is not a sandbox boundary — the container is. It is the gate
 * that keeps T43's `verify` honest: a declared test command can only run if
 * its argv shape is on the harness's declared allowlist, and a refusal is a
 * typed error + receipt, never a silent exec.
 */
import type { RunSignal } from "@shiba/shared";
import { boundTail } from "./security.js";
import type { ExecResult, SandboxOps } from "./runtime.js";

/** Refused: the command's argv matched no allowlist entry. */
export class ScopedExecRefusal extends Error {
  readonly command: string;
  constructor(command: string) {
    super(`Refused scoped exec: ${command}`);
    this.name = "ScopedExecRefusal";
    this.command = command;
  }
}

export interface ScopedExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  /** Per-command wall timeout; forwarded to the sandbox exec. */
  timeoutMs?: number;
  /** Per-stream output cap — keeps the TAIL (recent output is the signal). */
  maxOutputChars?: number;
  /** Allowlist entries: literal argv prefixes, e.g. ["pnpm", "test"]. */
  allowlist: readonly (readonly string[])[];
  /** Receipt collector — exec.invoked and exec.settled land here. */
  signals?: RunSignal[];
}

/** Default output cap for scoped (non-harness) commands. */
export const SCOPED_EXEC_OUTPUT_CAP = 8_192;

/** Cap on the receipt's command field — commands never carry env values. */
const RECEIPT_COMMAND_CAP = 200;

/**
 * Tokenize a shell-joined command into argv. Commands passing through here
 * are built by `shellJoin` (single-quoted escaping); this parser honors
 * single and double quotes only — no expansion, no substitution, no globs.
 * Unparseable input returns null (refused — we don't guess at intent).
 */
export function tokenizeCommand(command: string): string[] | null {
  const tokens: string[] = [];
  let i = 0;
  while (i < command.length) {
    while (i < command.length && /\s/.test(command[i]!)) i += 1;
    if (i >= command.length) break;
    let token = "";
    while (i < command.length && !/\s/.test(command[i]!)) {
      const ch = command[i]!;
      if (ch === "'" || ch === '"') {
        const close = command.indexOf(ch, i + 1);
        if (close < 0) return null; // unbalanced quote — refuse, never guess
        token += command.slice(i + 1, close);
        i = close + 1;
      } else if (ch === "\\" && i + 1 < command.length) {
        token += command[i + 1];
        i += 2;
      } else {
        token += ch;
        i += 1;
      }
    }
    tokens.push(token);
  }
  return tokens.length === 0 ? null : tokens;
}

/** True when every token of `prefix` equals the command argv's leading tokens. */
export function matchesPrefix(argv: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length === 0 || prefix.length > argv.length) return false;
  return prefix.every((token, i) => argv[i] === token);
}

function receipt(command: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ command: command.slice(0, RECEIPT_COMMAND_CAP), ...extra });
}

/**
 * Run `command` through the sandbox iff its argv matches an allowlist prefix.
 * Emits exec.invoked before the check (the attempt itself is evidence) and
 * exec.settled with exit/refused/thrown — the exec trail is complete even on
 * refusal. A refusal throws ScopedExecRefusal; callers decide whether that is
 * fatal (adapter-internal commands are always allowlisted, so a refusal there
 * is a bug) or evidence (a harness-requested command fails the verify, not the
 * run).
 */
export async function scopedExec(ops: SandboxOps, command: string, opts: ScopedExecOptions): Promise<ExecResult> {
  const signals = opts.signals;
  signals?.push({ kind: "exec.invoked", at: Date.now(), detail: receipt(command, {}) });

  const argv = tokenizeCommand(command);
  const allowed = argv !== null && opts.allowlist.some((prefix) => matchesPrefix(argv, prefix));
  if (!allowed) {
    signals?.push({ kind: "exec.settled", at: Date.now(), detail: receipt(command, { refused: true }) });
    throw new ScopedExecRefusal(command);
  }

  const cap = opts.maxOutputChars ?? SCOPED_EXEC_OUTPUT_CAP;
  const started = Date.now();
  try {
    const result = await ops.exec(command, {
      cwd: opts.cwd,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
      onOutput: opts.onOutput,
    });
    const truncated =
      result.stdout.length > cap || result.stderr.length > cap;
    signals?.push({
      kind: "exec.settled",
      at: Date.now(),
      detail: receipt(command, { exit: result.exitCode, ms: Date.now() - started, truncated }),
    });
    return {
      stdout: boundTail(result.stdout, cap),
      stderr: boundTail(result.stderr, cap),
      exitCode: result.exitCode,
    };
  } catch (error) {
    signals?.push({
      kind: "exec.settled",
      at: Date.now(),
      detail: receipt(command, { thrown: true, ms: Date.now() - started }),
    });
    throw error;
  }
}
