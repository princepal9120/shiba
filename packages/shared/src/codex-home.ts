/**
 * T49 — codex-subscription CODEX_HOME layout (PLAN.md §18.11).
 *
 * A port of t3code's `CodexHomeLayout` semantics: a Codex credential is
 * directory-shaped (`<home>/auth.json`), not a token in env, so account
 * isolation is a filesystem layout, not a header choice.
 *
 * Two-level layout:
 *   - a *shared* home holding everything non-account-specific (sessions,
 *     sqlite, worktrees, ...) — conversation history and the install live
 *     here;
 *   - a per-instance *shadow* home overlaying it: `auth.json` is a REAL
 *     file in the shadow (never a symlink into the shared home), every
 *     shared entry is linked in, and the shadow-local list stays private.
 *
 * The subtlety that must not be flattened: continuation key ≠ account key.
 * Continuation identity follows the SHARED home (`codex:home:<sharedPath>`)
 * — a conversation resumes against the same history across account
 * switches. Account identity follows the directory that actually holds
 * `auth.json` — `effectiveHomePath ?? sharedHomePath` — because an overlay
 * instance owns its account under the shadow while a plain instance shares
 * the common one. Keying usage/sign-out on the continuation key would
 * double-count a shared credit pool or fail to revoke an overlay account.
 *
 * Update path (ported verbatim): updates run against the SHARED home, not
 * the effective home — the overlay does not contain the installation, and
 * running the updater against it silently no-ops.
 */

/** Entries every Codex home shares — sessions, caches, the install. Ported verbatim. */
export const CODEX_KNOWN_SHARED_DIRECTORIES = [
  "sessions",
  "archived_sessions",
  "sqlite",
  "shell_snapshots",
  "worktrees",
  "skills",
  "plugins",
  "cache",
  "logs",
  "mcp-oauth-locks",
] as const;

/** Entries that must exist as real files in the effective home — never links into the shared home. */
export const CODEX_PRIVATE_ENTRY_NAMES = ["auth.json", "models_cache.json"] as const;

/** Entries the shadow keeps to itself even though they look shareable. */
export const CODEX_SHADOW_LOCAL_ENTRY_NAMES = ["log", "memories", "tmp"] as const;

/** Shared runtime dirs a stale non-symlink may be replaced for (lock dirs only). */
export const CODEX_REPLACEABLE_SHARED_RUNTIME_DIRECTORIES = ["mcp-oauth-locks"] as const;

export interface CodexHomeLayout {
  readonly mode: "direct" | "authOverlay";
  readonly sharedHomePath: string;
  /** Set in authOverlay mode only; the directory `CODEX_HOME` points at. */
  readonly effectiveHomePath: string | undefined;
  /** `codex:home:<sharedHomePath>` — the conversation's home across account switches. */
  readonly continuationKey: string;
  /** `codex:account:<dir holding auth.json>` — the identity T47 flows and quota key on. */
  readonly accountKey: string;
}

export class CodexHomePathConflictError extends Error {
  constructor(sharedHomePath: string, effectiveHomePath: string) {
    super(`Codex shadow home path '${effectiveHomePath}' must be different from the shared home path '${sharedHomePath}'.`);
    this.name = "CodexHomePathConflictError";
  }
}

export class CodexHomePrivateEntrySymlinkError extends Error {
  constructor(entryName: string, path: string) {
    super(`Codex shadow home private entry '${entryName}' at '${path}' must be a real file, not a symlink.`);
    this.name = "CodexHomePrivateEntrySymlinkError";
  }
}

export function isCodexPrivateEntry(entryName: string): boolean {
  return (CODEX_PRIVATE_ENTRY_NAMES as readonly string[]).includes(entryName);
}

export function isCodexShadowLocalEntry(entryName: string): boolean {
  return (CODEX_SHADOW_LOCAL_ENTRY_NAMES as readonly string[]).includes(entryName);
}

/**
 * Resolve the two-level layout. `shadowHomePath` empty/absent → direct mode:
 * the account lives in the shared home itself. Otherwise the shadow overlays
 * it and owns `auth.json`. Paths are normalized against trailing slashes;
 * callers pass already-absolute sandbox paths.
 */
export function resolveCodexSubscriptionHome(input: {
  sharedHomePath: string;
  shadowHomePath?: string | undefined;
}): CodexHomeLayout {
  const sharedHomePath = normalizeHomePath(input.sharedHomePath);
  const shadow = input.shadowHomePath?.trim();
  if (shadow === undefined || shadow === "") {
    return {
      mode: "direct",
      sharedHomePath,
      effectiveHomePath: undefined,
      continuationKey: `codex:home:${sharedHomePath}`,
      accountKey: `codex:account:${sharedHomePath}`,
    };
  }
  const effectiveHomePath = normalizeHomePath(shadow);
  if (effectiveHomePath === sharedHomePath) {
    throw new CodexHomePathConflictError(sharedHomePath, effectiveHomePath);
  }
  return {
    mode: "authOverlay",
    sharedHomePath,
    effectiveHomePath,
    continuationKey: `codex:home:${sharedHomePath}`,
    accountKey: `codex:account:${effectiveHomePath}`,
  };
}

function normalizeHomePath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/**
 * The materialization plan for an overlay home, as ordered argv ops the
 * runtime adapter executes through scoped exec. Pure: observable shared
 * entries come in as `extraSharedEntries` (the materializer may list the
 * shared home and add unknown entries; known/observed entries are linked,
 * private and shadow-local names are NEVER linked).
 *
 * The private-entry-symlink refusal lives in `assertCodexPrivateEntriesReal`
 * — whoever materializes must run it over the effective home's existing
 * auth.json/models_cache.json state before writing, and the plan itself
 * can never produce a symlink op for a private entry.
 */
export type CodexHomeOp =
  | { readonly op: "mkdir"; readonly path: string }
  | { readonly op: "symlink"; readonly target: string; readonly link: string };

export function codexShadowHomeOps(
  layout: CodexHomeLayout,
  extraSharedEntries: readonly string[] = [],
): CodexHomeOp[] {
  const ops: CodexHomeOp[] = [{ op: "mkdir", path: layout.sharedHomePath }];
  for (const dir of CODEX_KNOWN_SHARED_DIRECTORIES) {
    ops.push({ op: "mkdir", path: `${layout.sharedHomePath}/${dir}` });
  }
  if (layout.mode !== "authOverlay" || layout.effectiveHomePath === undefined) {
    return ops;
  }
  const effective = layout.effectiveHomePath;
  ops.push({ op: "mkdir", path: effective });
  for (const dir of CODEX_SHADOW_LOCAL_ENTRY_NAMES) {
    ops.push({ op: "mkdir", path: `${effective}/${dir}` });
  }
  const linked = new Set<string>(CODEX_KNOWN_SHARED_DIRECTORIES);
  for (const entry of extraSharedEntries) {
    if (!isCodexPrivateEntry(entry) && !isCodexShadowLocalEntry(entry)) linked.add(entry);
  }
  for (const entry of linked) {
    ops.push({
      op: "symlink",
      target: `${layout.sharedHomePath}/${entry}`,
      link: `${effective}/${entry}`,
    });
  }
  return ops;
}

/**
 * The refusal: private entries in the effective home must be real files.
 * `entries` maps a private entry name to its observed kind in the effective
 * home — a "symlink" kills the run before any write, exactly as t3code's
 * `ensureShadowAuthIsPrivate` does.
 */
export function assertCodexPrivateEntriesReal(
  layout: CodexHomeLayout,
  entries: Readonly<Record<string, "file" | "symlink" | "missing">>,
): void {
  const effective = layout.effectiveHomePath ?? layout.sharedHomePath;
  for (const entryName of CODEX_PRIVATE_ENTRY_NAMES) {
    if (entries[entryName] === "symlink") {
      throw new CodexHomePrivateEntrySymlinkError(entryName, `${effective}/${entryName}`);
    }
  }
}

/** The directory updates must run against — always the shared home. */
export function codexUpdateHomePath(layout: CodexHomeLayout): string {
  return layout.sharedHomePath;
}

/**
 * Recover the account name from a `codex-sub:<homeDir>` instanceId — the
 * shadow dir encodes it (`acc-<name>`); the shared home means "default".
 * Lives here (not in harness/) so `src/auth/` resolves it without
 * crossing the `src/auth/ → harness/` dependency rule.
 */
export function codexSubscriptionAccountFromInstanceId(instanceId: string): string {
  const path = instanceId.slice("codex-sub:".length);
  const base = path.split("/").pop() ?? "";
  return base.startsWith("acc-") ? base.slice(4) : "default";
}
