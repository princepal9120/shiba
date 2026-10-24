/**
 * T72: a repo's own setup, committed at `.shiba/setup.json`. Runs only when
 * the human ticked "Run repo setup" for this run — the flag is approval-hashed.
 *
 * Shape (format_version 1): `{ format_version: 1, scripts?: { initialize?: string },
 * timeouts?: { initialize?: seconds } }`. Unknown keys are refused so a typo fails loudly.
 */
import { scopedExec } from "./exec-allowlist.js";
import type { ProgressEmitter, SandboxOps } from "./runtime.js";
import { boundTail, shellJoin } from "./security.js";
import type { RunSignal } from "@shiba/shared";

export const SETUP_FILE = ".shiba/setup.json";
const DEFAULT_TIMEOUT_S = 600;
// Keeps clone + setup + harness + git under RUN_DEADLINE_MS, or the reclaim sweep kills a working run.
const MAX_TIMEOUT_S = 900;
const MAX_SCRIPT_CHARS = 8000;
// The one place the adapter runs repo-authored shell, so it gets its own allowlist entry.
const SETUP_SCRIPT_ALLOWLIST: readonly (readonly string[])[] = [["sh", "-c"]];
const GIT_ALLOWLIST: readonly (readonly string[])[] = [["git"]];

export interface RepoSetup {
  initialize?: string;
  timeoutMs: number;
}

function section(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${name} has unknown key ${JSON.stringify(unknown[0])}`);
  return value as Record<string, unknown>;
}

/** Throws a user-facing message on any shape problem. */
export function parseRepoSetup(text: string): RepoSetup {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("not valid JSON");
  }
  // refresh and entries are accepted so a Capy-shaped file loads; they aren't run yet (T74).
  const file = section(raw, "the file", ["$schema", "format_version", "scripts", "timeouts", "entries"]);
  if (file.format_version !== 1) throw new Error("format_version must be 1");
  const scripts = section(file.scripts, "scripts", ["initialize", "refresh"]);
  const timeouts = section(file.timeouts, "timeouts", ["initialize", "refresh"]);
  const initialize = scripts.initialize;
  if (initialize !== undefined && (typeof initialize !== "string" || !initialize.trim() || initialize.length > MAX_SCRIPT_CHARS)) {
    throw new Error(`scripts.initialize must be a non-empty string of at most ${MAX_SCRIPT_CHARS} characters`);
  }
  const seconds = timeouts.initialize ?? DEFAULT_TIMEOUT_S;
  if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_TIMEOUT_S) {
    throw new Error(`timeouts.initialize must be a whole number of seconds from 1 to ${MAX_TIMEOUT_S}`);
  }
  return { ...(initialize !== undefined ? { initialize } : {}), timeoutMs: seconds * 1000 };
}

export interface RepoSetupOutcome {
  /** A failure summary, or null when setup succeeded or had nothing to run. */
  failure: string | null;
  /** The local commit holding setup's effects; an agent edit to a path it touched is an overlap. */
  commit: string | null;
}

// Hooks and fsmonitor off on every set-aside call: this is bookkeeping, never the repo's own logic.
const QUIET_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const SET_ASIDE_TIMEOUT_MS = 120_000;

/** Paths among `paths` that the setup commit changed. Throws if git can't answer — never assume none. */
export async function setupOverlap(
  ops: SandboxOps,
  workdir: string,
  commit: string,
  paths: readonly string[],
  opts: { signals: RunSignal[]; signal?: AbortSignal },
): Promise<string[]> {
  if (paths.length === 0) return [];
  const listed = await scopedExec(
    ops,
    shellJoin(["git", ...QUIET_GIT, "diff-tree", "--no-commit-id", "--name-only", "-r", "-z", commit, "--", ...paths]),
    { cwd: workdir, allowlist: GIT_ALLOWLIST, signals: opts.signals, signal: opts.signal, timeoutMs: SET_ASIDE_TIMEOUT_MS },
  );
  if (listed.exitCode !== 0) throw new Error(`could not compare with the setup's changes (git exit ${listed.exitCode})`);
  return listed.stdout.split("\0").filter(Boolean);
}

export async function runRepoSetup(
  ops: SandboxOps,
  workdir: string,
  opts: {
    env?: Record<string, string>;
    scrub: (text: string) => string;
    signals: RunSignal[];
    signal?: AbortSignal;
    emit: ProgressEmitter;
  },
): Promise<RepoSetupOutcome> {
  const fail = (failure: string): RepoSetupOutcome => ({ failure, commit: null });
  const git = (args: string[]) =>
    scopedExec(ops, shellJoin(["git", ...QUIET_GIT, ...args]), {
      cwd: workdir,
      allowlist: GIT_ALLOWLIST,
      signals: opts.signals,
      signal: opts.signal,
      timeoutMs: SET_ASIDE_TIMEOUT_MS,
    });
  let file: Awaited<ReturnType<SandboxOps["readFile"]>>;
  try {
    file = await ops.readFile(`${workdir}/${SETUP_FILE}`, { maxBytes: 64_000, signal: opts.signal });
  } catch (error) {
    const tracked = await git(["ls-files", "--error-unmatch", "--", SETUP_FILE]).catch(() => null);
    if (tracked === null || tracked.exitCode !== 0) {
      return fail(`Repo setup was requested, but the repository has no ${SETUP_FILE}.`);
    }
    return fail(`${SETUP_FILE} could not be read: ${opts.scrub(error instanceof Error ? error.message : String(error))}`);
  }
  let setup: RepoSetup;
  try {
    if (file.kind !== "utf8") throw new Error("must be UTF-8 text");
    setup = parseRepoSetup(file.content);
  } catch (error) {
    return fail(`${SETUP_FILE} is invalid: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (setup.initialize === undefined) return { failure: null, commit: null };
  await opts.emit({ phase: "configure", message: `Running ${SETUP_FILE} initialize.`, fraction: 0.1 });
  try {
    const result = await scopedExec(ops, shellJoin(["sh", "-c", setup.initialize]), {
      cwd: workdir,
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      allowlist: SETUP_SCRIPT_ALLOWLIST,
      timeoutMs: setup.timeoutMs,
      signals: opts.signals,
      signal: opts.signal,
      receiptLabel: `${SETUP_FILE}#initialize`,
    });
    if (result.exitCode !== 0) {
      const output = boundTail(opts.scrub(`${result.stdout}\n${result.stderr}`.trim()), 1500);
      return fail(`${SETUP_FILE} initialize exited with code ${result.exitCode}.${output ? ` Output: ${output}` : ""}`);
    }
    // Fold setup's effects into a local-only commit so status-based collection, the diff and the PR
    // see only the agent's changes. Signing off; never pushed (publish builds from collected files).
    await opts.emit({ phase: "configure", message: "Setting the setup's changes aside.", fraction: 0.12 });
    const add = await git(["add", "-A"]);
    const commit =
      add.exitCode === 0
        ? await git([
            "-c", "commit.gpgsign=false", "-c", "user.name=shiba", "-c", "user.email=shiba@localhost",
            "commit", "--no-verify", "--allow-empty", "-q", "-m", "shiba: repo setup (local only)",
          ])
        : add;
    const head = commit.exitCode === 0 ? await git(["rev-parse", "HEAD"]) : commit;
    const sha = head.stdout.trim();
    if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
      return fail(`Could not set aside the setup's changes: ${boundTail(opts.scrub(head.stderr.trim()), 500)}`);
    }
    return { failure: null, commit: sha };
  } catch (error) {
    return fail(`${SETUP_FILE} initialize failed: ${opts.scrub(error instanceof Error ? error.message : String(error))}`);
  }
}
