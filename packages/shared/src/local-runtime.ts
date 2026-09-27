/**
 * T51 (PLAN.md §18.13): the "local" runtime — the operator's own machine
 * executes the run through a thin daemon while the Worker keeps the whole
 * control plane (approval card, receipts, verdict, Worker-side publish).
 *
 * The seam is a mailbox, not a socket: the Worker writes a
 * `LocalRunEnvelope` into the LocalDispatch DO, an operator-run daemon
 * (`scripts/shiba-local-daemon.mjs`) claims it outbound over
 * `/api/local/*`, executes it, and posts the result back. No inbound port,
 * no credential transit: the daemon is the only side holding agent auth.
 *
 * Everything in this file is pure — shared between the Worker's envelope
 * builder, the dispatch DO's records, and (mirrored in JS) the daemon.
 */
import { z } from "zod";

/** Runtimes an intake surface may ask for. "computer" stays env-only. */
export const RUNTIME_SELECTIONS = ["sandbox", "local"] as const;
export type RuntimeSelection = (typeof RUNTIME_SELECTIONS)[number];
export const runtimeSelectionSchema = z.enum(RUNTIME_SELECTIONS);

/** First-class opt-in (off by default): `SHIBA_LOCAL_RUNTIME=1`. */
export const LOCAL_RUNTIME_FLAG = "SHIBA_LOCAL_RUNTIME";

/** Daemon bearer credential (Worker secret, never a var). */
export const LOCAL_ADAPTER_TOKEN_ENV = "LOCAL_ADAPTER_TOKEN";

/** Singleton LocalDispatch DO name — one claim queue per deployment. */
export const LOCAL_DISPATCH_DO_NAME = "local-dispatch";

/**
 * Header the Worker's authenticated /api/runs handler sets after stripping
 * any inbound copy: the DO refuses runtime:"local" without it, so Slack,
 * MCP, email, and automation intakes can never mint a local run.
 */
export const LOCAL_INTAKE_HEADER = "X-Shiba-Intake";
export const LOCAL_INTAKE_DASHBOARD = "dashboard";

/**
 * Placeholder the envelope carries where a container path would go: the
 * daemon substitutes the run's root (`~/.shiba-local/runs/<sandboxId>`).
 * Keeping token substitution client-side means the Worker never sees or
 * emits operator-machine paths.
 */
export const LOCAL_RUN_ROOT_TOKEN = "${SHIBA_LOCAL_RUN_ROOT}";
/** The container workdir `/workspace/<sandboxId>` maps to this subdir. */
export const LOCAL_WORK_SUBDIR = "work";
/** The container home `/root` maps to this subdir — the run's own HOME. */
export const LOCAL_HOME_SUBDIR = "home";

const ENV_VALUE_MAX = 8_192;
const TASK_MAX = 16_384;
const PATH_MAX = 4_096;

export const localRunEnvelopeSchema = z.object({
  version: z.literal(1),
  sandboxId: z.string().min(1).max(128),
  repoUrl: z.string().min(1).max(2048),
  baseBranch: z.string().min(1).max(256),
  task: z.string().min(1).max(TASK_MAX),
  harness: z.string().min(1).max(64),
  /** Root-tokenized absolute paths the daemon resolves before use. */
  cloneDir: z.string().min(1).max(PATH_MAX),
  homeDir: z.string().min(1).max(PATH_MAX),
  setupCommands: z.array(z.array(z.string().min(1).max(PATH_MAX)).min(1).max(8)).max(16),
  configFiles: z.array(
    z.object({
      path: z.string().min(1).max(PATH_MAX),
      contents: z.string().max(500_000),
    }),
  ).max(16),
  argv: z.array(z.string().min(1).max(PATH_MAX)).min(1).max(64),
  env: z.record(z.string().min(1).max(128), z.string().max(ENV_VALUE_MAX)),
  testCommand: z.array(z.string().min(1).max(PATH_MAX)).max(8).optional(),
  /**
   * The harness's declared argv-prefix allowlist — the daemon refuses the
   * test command against the same prefixes scopedExec would, so a local
   * run cannot exec what the sandbox runtime would not.
   */
  execAllowlist: z.array(z.array(z.string().min(1).max(256)).min(1).max(8)).max(32),
  /** The harness's setup-op allowlist, same treatment. */
  setupAllowlist: z.array(z.array(z.string().min(1).max(256)).min(1).max(4)).max(8),
  /** Wall-clock deadline the daemon honors; the run reclaims past it anyway. */
  deadlineAt: z.number().int().positive(),
  createdAt: z.number().int().positive(),
});
export type LocalRunEnvelope = z.infer<typeof localRunEnvelopeSchema>;

/** The daemon's report — what the adapter hands the verify gate. */
export const localRunResultSchema = z.object({
  status: z.enum(["completed", "error"]),
  exitCode: z.number().int(),
  summary: z.string().max(16_384),
  stderrTail: z.string().max(16_384),
  stdoutTail: z.string().max(64_000).optional(),
  changedFiles: z.array(z.string().max(1024)).max(512),
  diff: z.string().max(2_000_000),
  files: z.array(
    z.object({
      path: z.string().min(1).max(1024),
      content: z.string().max(200_000).nullable(),
      encoding: z.enum(["utf8", "base64"]),
    }),
  ).max(128),
  testEvidence: z
    .object({
      command: z.string().max(PATH_MAX),
      exitCode: z.number().int(),
      outputTail: z.string().max(16_384),
    })
    .optional(),
  /** Daemon-emitted exec/settle receipts; the adapter merges them in. */
  signals: z
    .array(z.object({ kind: z.string(), at: z.number(), detail: z.string().max(512).optional() }))
    .max(512)
    .optional(),
});
export type LocalRunResult = z.infer<typeof localRunResultSchema>;

export type LocalDispatchStatus = "pending" | "claimed" | "settled" | "cancelled";

/** The LocalDispatch DO's record for one sandboxId. */
export interface LocalDispatchRecord {
  envelope: LocalRunEnvelope;
  status: LocalDispatchStatus;
  /** Minted at claim; results must present it — a second daemon can't hijack. */
  claimToken?: string;
  claimedAt?: number;
  claimedBy?: string;
  result?: LocalRunResult;
  settledAt?: number;
}

/** A claimed record goes stale this long after its claim with no result —
 * the adapter's own deadline always lands first; this only reaps orphans. */
export const LOCAL_CLAIM_STALE_MS = 45 * 60 * 1000;

/** Tokenize one container path for the daemon's run-root substitution. */
export function localizeContainerPath(path: string, sandboxId: string): string {
  const workPrefix = `/workspace/${sandboxId}`;
  if (path === workPrefix) return `${LOCAL_RUN_ROOT_TOKEN}/${LOCAL_WORK_SUBDIR}`;
  if (path.startsWith(`${workPrefix}/`)) {
    return `${LOCAL_RUN_ROOT_TOKEN}/${LOCAL_WORK_SUBDIR}${path.slice(workPrefix.length)}`;
  }
  if (path === "/root") return `${LOCAL_RUN_ROOT_TOKEN}/${LOCAL_HOME_SUBDIR}`;
  if (path.startsWith("/root/")) {
    return `${LOCAL_RUN_ROOT_TOKEN}/${LOCAL_HOME_SUBDIR}${path.slice("/root".length)}`;
  }
  return path;
}

/**
 * Rewrite the container-shaped harness invocation into the local envelope:
 *   - paths under /root or /workspace/<sandboxId> become run-root tokens;
 *   - env values equal to the dummy provider key are dropped — the dummy
 *     exists only for sandbox egress pinning; locally the operator's own
 *     environment carries real credentials (or none, for sign-in CLIs);
 *   - the dummy key inside config file bodies becomes an env reference —
 *     opencode resolves `{env:VAR}` placeholders in provider options.
 */
export function buildLocalRunEnvelope(args: {
  input: {
    sandboxId: string;
    repoUrl: string;
    baseBranch: string;
    task: string;
    testCommand?: string[];
  };
  harnessName: string;
  /** Container workdir the harness's argv/config were computed against. */
  workdir: string;
  configFiles: { path: string; contents: string }[];
  setupCommands: string[][];
  argv: string[];
  env: Record<string, string>;
  /** The sandbox's provider-key sentinel — stripped from env, env-referenced in config. */
  dummyKey: string;
  /** Env var the provider key lives under locally (config `{env:...}` target). */
  providerKeyEnv?: string;
  /** Harness-declared exec allowlists — copied verbatim into the envelope. */
  execAllowlist: string[][];
  setupAllowlist: string[][];
  deadlineAt: number;
  now?: number;
}): LocalRunEnvelope {
  const { input, dummyKey, providerKeyEnv } = args;
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(args.env)) {
    if (value === dummyKey) continue;
    env[key] = localizeContainerPath(value, input.sandboxId);
  }
  const configFiles = args.configFiles.map((file) => ({
    path: localizeContainerPath(file.path, input.sandboxId),
    contents:
      providerKeyEnv !== undefined
        ? file.contents.split(JSON.stringify(dummyKey)).join(JSON.stringify(`{env:${providerKeyEnv}}`))
        : file.contents,
  }));
  return localRunEnvelopeSchema.parse({
    version: 1,
    sandboxId: input.sandboxId,
    repoUrl: input.repoUrl,
    baseBranch: input.baseBranch,
    task: input.task,
    harness: args.harnessName,
    cloneDir: `${LOCAL_RUN_ROOT_TOKEN}/${LOCAL_WORK_SUBDIR}`,
    homeDir: `${LOCAL_RUN_ROOT_TOKEN}/${LOCAL_HOME_SUBDIR}`,
    setupCommands: args.setupCommands.map((cmd) =>
      cmd.map((part) => localizeContainerPath(part, input.sandboxId)),
    ),
    configFiles,
    argv: args.argv.map((part) => localizeContainerPath(part, input.sandboxId)),
    env,
    ...(input.testCommand !== undefined && input.testCommand.length > 0
      ? {
          testCommand: input.testCommand.map((part) =>
            localizeContainerPath(part, input.sandboxId),
          ),
        }
      : {}),
    execAllowlist: args.execAllowlist,
    setupAllowlist: args.setupAllowlist,
    deadlineAt: args.deadlineAt,
    createdAt: args.now ?? Date.now(),
  });
}

/**
 * ── Installer-lease machinery (ported from t3code's release manager) ─────
 * Binaries and run workspaces live under a root of IMMUTABLE entries plus
 * a single `current` pointer; a running process holds a LEASE file so a
 * reclamation pass never deletes a live install/workspace out from under
 * it. All pure — the daemon performs the filesystem effects.
 */

/** `releases/` holds immutable `<name>/<version>` dirs; `leases/` holds live holders. */
export function localReleaseDir(root: string, name: string, version: string): string {
  return `${root}/releases/${name}/${version}`;
}

/** The atomic pointer file naming the active release for `name`. */
export function localCurrentPointerPath(root: string, name: string): string {
  return `${root}/releases/${name}/current`;
}

/** Lease file for one holder of a release or workspace. */
export function localLeasePath(root: string, name: string, holderId: string): string {
  return `${root}/leases/${name}/${holderId}.lease`;
}

/**
 * Which release dir a daemon should run from: the one `current` names,
 * else the newest `version` present, else null (install required). Versions
 * compare as dotted numerics; a non-numeric segment sorts lexically after.
 */
export function resolveLocalRelease(args: {
  current?: string;
  versions: string[];
}): string | null {
  if (args.current !== undefined && args.versions.includes(args.current)) {
    return args.current;
  }
  const sorted = [...args.versions].sort(compareReleaseVersions);
  return sorted.length > 0 ? (sorted[sorted.length - 1] as string) : null;
}

/** Dotted-numeric compare (1.10.0 > 1.9.0); equal numerics compare tail text. */
export function compareReleaseVersions(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? "";
    const sb = pb[i] ?? "";
    const na = /^\d+$/.test(sa) ? Number(sa) : Number.NaN;
    const nb = /^\d+$/.test(sb) ? Number(sb) : Number.NaN;
    if (Number.isNaN(na) && Number.isNaN(nb)) {
      if (sa < sb) return -1;
      if (sa > sb) return 1;
      continue;
    }
    if (Number.isNaN(na)) return 1;
    if (Number.isNaN(nb)) return -1;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Reclaimable = a lease file whose holder is gone. `isHolderAlive` is
 * injected (process liveness on the daemon's OS) so the rule stays pure:
 * a lease survives iff its holder is still alive — a dead holder's lease
 * may be removed even while it lists the release as held.
 */
export function leaseIsReclaimable(args: {
  holderAlive: boolean;
}): boolean {
  return !args.holderAlive;
}
