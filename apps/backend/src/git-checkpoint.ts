/**
 * T44 — git checkpointing via hidden refs (PLAN.md §18.5), the t3code
 * CheckpointStore pattern scoped to shiba's destroyed-on-settle sandbox.
 *
 * `refs/shiba/checkpoints/<runId>/<seq>` commits capture the whole worktree
 * (including untracked files) without touching HEAD or the user's branch.
 * Baseline is captured immediately post-clone, a settle ref after the
 * harness exits, and the turn diff is `diffCheckpoints(baseline, settle)` —
 * commit-to-commit, so intent-to-add hacks are unnecessary.
 *
 * Refs die with the sandbox; their durable product is the diff (exported to
 * R2 by the caller when it exceeds the inline cap) and the receipts.
 *
 * Revert is honest about the t3code trap: restoring the workspace without
 * the conversation creates a file/context divergence, so `restoreCheckpoint`
 * refuses up front on a harness whose `supportsConversationRollback` is
 * false — every harness today — rather than half-restoring state.
 */
import type { AgentHarness } from "./harness/types.js";
import { boundTail, shellJoin } from "./security.js";

export const CHECKPOINT_REF_PREFIX = "refs/shiba/checkpoints/";

/** Strict shape: derived names only, no user input — `..`, spaces, or odd charset rejected outright. */
export function isCheckpointRef(ref: string): boolean {
  return /^refs\/shiba\/checkpoints\/[A-Za-z0-9_-]+\/[0-9]+$/.test(ref);
}

export function checkpointRef(runId: string, seq: number): string {
  const ref = `${CHECKPOINT_REF_PREFIX}${runId}/${seq}`;
  if (!isCheckpointRef(ref)) {
    throw new Error(`Invalid checkpoint coordinates: runId=${JSON.stringify(runId)} seq=${seq}`);
  }
  return ref;
}

/** Restore without conversation rollback is refused before touching the fs. */
export class CheckpointRollbackRefusal extends Error {
  constructor(harnessName: string) {
    super(
      `Refused checkpoint restore: the ${harnessName} harness cannot roll back its ` +
        "conversation, so restoring the workspace alone would diverge file state " +
        "from what the agent believes it did.",
    );
    this.name = "CheckpointRollbackRefusal";
  }
}

export interface CheckpointOps {
  exec(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      maxOutputChars?: number;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/** A diff legitimately exceeds the default scoped cap — bound memory, keep the whole payload. */
const DIFF_OUTPUT_CAP = 20_000_000;

async function git(
  ops: CheckpointOps,
  workdir: string,
  argv: string[],
  env?: Record<string, string>,
  signal?: AbortSignal,
  maxOutputChars?: number,
): Promise<string> {
  const result = await ops.exec(shellJoin(["git", ...argv]), {
    cwd: workdir,
    timeoutMs: 60_000,
    env,
    signal,
    maxOutputChars,
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${argv[0]} failed: ${boundTail(result.stderr, 1000)}`);
  }
  // Raw stdout — diffs keep their exact bytes; callers trim oid output.
  return result.stdout;
}

/**
 * Commit the entire worktree (tracked + untracked) to `ref` via a temporary
 * index, leaving HEAD, the real index, and the user's branch untouched.
 * Returns the checkpoint commit oid.
 */
export async function captureCheckpoint(
  ops: CheckpointOps,
  workdir: string,
  runId: string,
  seq: number,
  signal?: AbortSignal,
): Promise<string> {
  const ref = checkpointRef(runId, seq);
  const gitDir = (await git(ops, workdir, ["rev-parse", "--git-dir"], undefined, signal)).trim();
  // Inside .git so it never shows up as an untracked worktree file; it dies
  // with the sandbox, so there is nothing to unlink.
  const tmpIndex = `${gitDir}/shiba-checkpoint-index-${seq}`;
  const env = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: "shiba",
    GIT_AUTHOR_EMAIL: "shiba@shiba.local",
    GIT_COMMITTER_NAME: "shiba",
    GIT_COMMITTER_EMAIL: "shiba@shiba.local",
  };
  await git(ops, workdir, ["read-tree", "HEAD"], env, signal);
  await git(ops, workdir, ["add", "-A"], env, signal);
  const tree = (await git(ops, workdir, ["write-tree"], env, signal)).trim();
  const commit = (
    await git(ops, workdir, ["commit-tree", tree, "-p", "HEAD", "-m", `shiba checkpoint ${runId}#${seq}`], env, signal)
  ).trim();
  await git(ops, workdir, ["update-ref", ref, commit], env, signal);
  return commit;
}

/** Turn diff between two checkpoint refs. Refs are validated before reaching git. */
export async function diffCheckpoints(
  ops: CheckpointOps,
  workdir: string,
  fromRef: string,
  toRef: string,
  signal?: AbortSignal,
): Promise<string> {
  for (const ref of [fromRef, toRef]) {
    if (!isCheckpointRef(ref)) throw new Error(`Refused crafted ref name: ${JSON.stringify(ref)}`);
  }
  return git(ops, workdir, ["diff", fromRef, toRef], undefined, signal, DIFF_OUTPUT_CAP);
}

/**
 * Restore the worktree to a checkpoint — only reachable when the harness can
 * roll back its conversation too. Refuses otherwise, before touching the fs.
 */
export async function restoreCheckpoint(
  ops: CheckpointOps,
  workdir: string,
  ref: string,
  harness: AgentHarness,
  signal?: AbortSignal,
): Promise<void> {
  if (!isCheckpointRef(ref)) throw new Error(`Refused crafted ref name: ${JSON.stringify(ref)}`);
  if (!harness.capabilities().supportsConversationRollback) {
    throw new CheckpointRollbackRefusal(harness.name);
  }
  await git(ops, workdir, ["restore", "--source", ref, "--staged", "--worktree", "--", "."], undefined, signal);
  // Untracked files added since the checkpoint are not covered by restore.
  await git(ops, workdir, ["clean", "-fd"], undefined, signal);
}

/** Drop all but the newest `keepLast` checkpoint refs for a run. */
export async function pruneCheckpoints(
  ops: CheckpointOps,
  workdir: string,
  runId: string,
  keepLast: number,
  signal?: AbortSignal,
): Promise<void> {
  const prefix = `${CHECKPOINT_REF_PREFIX}${runId}/`;
  const listed = await git(ops, workdir, ["for-each-ref", "--format=%(refname)", prefix], undefined, signal);
  const refs = listed.split("\n").filter((line) => isCheckpointRef(line.trim()));
  // Sequence sort — refs are <prefix><seq>, numeric tail order.
  const bySeq = (ref: string) => Number(ref.slice(prefix.length));
  refs.sort((a, b) => bySeq(a) - bySeq(b));
  for (const stale of refs.slice(0, Math.max(0, refs.length - keepLast))) {
    await git(ops, workdir, ["update-ref", "-d", stale], undefined, signal);
  }
}
