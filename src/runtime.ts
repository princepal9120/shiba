/**
 * Runtime adapter seam. The default adapter wraps the Sandbox SDK.
 * An experimental adapter for @cloudflare/computer exists only as a
 * guarded refusal: Computer is preview-only, so it must never silently
 * replace the default Sandbox path.
 *
 * What agent runs inside the sandbox is a second, narrower seam:
 * AgentHarness (src/harness/types.ts). SandboxRuntimeAdapter keeps
 * clone → configure → run → collect; only config, argv, and event parsing
 * are harness-dispatched (default: OpenCode).
 */
import type { CodingTaskInput, CodingTaskResult } from "./opencode-input.js";
import { ClaudeCodeErrorEvent } from "./harness/claude-code.js";
import { CodexErrorEvent } from "./harness/codex.js";
import { OpenCodeErrorEvent as OpenCodeErrorEventImpl, opencodeHarness } from "./harness/opencode.js";
import type { AgentHarness } from "./harness/types.js";
import { boundTail, redactSecrets, shellJoin, shellQuote } from "./security.js";

export const MAX_DIFF_CHARS = 120_000;
export const MAX_STDERR_TAIL_CHARS = 8_000;
export const MAX_STDOUT_TAIL_CHARS = 30_000;
export const MAX_CAPTURED_FILES = 50;
export const MAX_FILE_CHARS = 100_000;
export const MAX_TOTAL_FILE_CHARS = 500_000;
export const OPENCODE_TIMEOUT_MS = 15 * 60 * 1000;
export const GIT_TIMEOUT_MS = 5 * 60 * 1000;
export const MAX_PROGRESS_EVENTS = 256;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxOps {
  gitCheckout(repoUrl: string, opts: { branch: string; targetDir: string }): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
  exec(
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", data: string) => void;
    },
  ): Promise<ExecResult>;
  readFile(path: string, opts?: { maxBytes?: number; signal?: AbortSignal }): Promise<
    { kind: "utf8"; content: string } | { kind: "base64"; content: string }
  >;
}

export interface ProgressEvent {
  phase: "clone" | "configure" | "code" | "collect";
  message: string;
  fraction: number;
}

export type ProgressEmitter = (event: ProgressEvent) => void | Promise<void>;

export interface RuntimeAdapter {
  readonly name: "sandbox" | "computer";
  runCodingTask(
    ops: SandboxOps,
    input: CodingTaskInput,
    emit: ProgressEmitter,
    opts?: { signal?: AbortSignal },
  ): Promise<CodingTaskResult>;
}

export const COMPUTER_PREVIEW_MESSAGE =
  "@cloudflare/computer is preview-only and not production-ready, so it is disabled. " +
  "Set RUNTIME=sandbox (the default) or wait for Computer to graduate from preview. " +
  "Sandbox remains the default isolated repository runtime.";

export class SandboxRuntimeAdapter implements RuntimeAdapter {
  readonly name = "sandbox" as const;
  private readonly harness: AgentHarness;

  constructor(harness: AgentHarness = opencodeHarness) {
    this.harness = harness;
  }

  async runCodingTask(
    ops: SandboxOps,
    input: CodingTaskInput,
    emit: ProgressEmitter,
    opts?: { signal?: AbortSignal },
  ): Promise<CodingTaskResult> {
    const workdir = `/workspace/${input.sandboxId}`;
    const config = this.harness.configFile(input, input.sandboxId);

    throwIfAborted(opts?.signal);
    await emit({ phase: "clone", message: `Cloning ${input.repoUrl} (branch ${input.baseBranch}).`, fraction: 0.05 });
    try {
      await ops.gitCheckout(input.repoUrl, { branch: input.baseBranch, targetDir: workdir });
    } catch (error) {
      return failureResult(`Clone failed: ${shortError(error)}`, 0, "");
    }

    await emit({ phase: "configure", message: "Writing isolated OpenCode config.", fraction: 0.15 });
    throwIfAborted(opts?.signal);
    try {
      if (config) await ops.writeFile(config.path, config.contents);
    } catch (error) {
      return failureResult(`Config write failed: ${shortError(error)}`, 0, "");
    }

    await emit({ phase: "code", message: "Running OpenCode headlessly.", fraction: 0.25 });
    throwIfAborted(opts?.signal);
    const argv = this.harness.buildArgv(input, workdir);
    let run: ExecResult;
    const output = streamProgress(this.harness, emit, opts?.signal);
    try {
      run = await ops.exec(shellJoin(argv), {
        cwd: workdir,
        timeoutMs: OPENCODE_TIMEOUT_MS,
        signal: opts?.signal,
        onOutput: output.onData,
        // Provider keys here are always the dummy; the real credential is
        // swapped in outside the container (src/egress.ts).
        env: this.harness.env(input, config?.path ?? null),
      });
      await output.finish();
      throwIfAborted(opts?.signal);
    } catch (error) {
      await output.finish();
      throwIfAborted(opts?.signal);
      if (
        error instanceof OpenCodeErrorEventImpl ||
        error instanceof ClaudeCodeErrorEvent ||
        error instanceof CodexErrorEvent
      ) {
        return failureResult(error.message, 0, "");
      }
      return failureResult(`OpenCode execution failed: ${shortError(error)}`, 0, "");
    }
    const stderrTail = redactSecrets(boundTail(run.stderr, MAX_STDERR_TAIL_CHARS));
    if (run.exitCode !== 0) {
      return failureResult(
        `OpenCode exited with code ${run.exitCode}.`,
        run.exitCode,
        stderrTail,
      );
    }

    await emit({ phase: "collect", message: "Collecting changed files and diff.", fraction: 0.85 });
    // Abort stays allowed here: collection is read-side only — no external
    // write exists between the harness exec and the returned result.
    throwIfAborted(opts?.signal);
    try {
      const collection = await collectChanges(ops, workdir, opts?.signal);
      await emit({ phase: "collect", message: `Done: ${collection.changedFiles.length} changed files.`, fraction: 1 });
      return {
        status: "completed",
        exitCode: 0,
        stderrTail,
        changedFiles: collection.changedFiles,
        diff: collection.diff,
        files: collection.files,
        summary: summarizeRun(input, collection.changedFiles, boundTail(run.stdout, MAX_STDOUT_TAIL_CHARS)),
      };
    } catch (error) {
      return failureResult(`Change collection failed: ${shortError(error)}`, run.exitCode, stderrTail);
    }
  }
}

export class ComputerPreviewAdapter implements RuntimeAdapter {
  readonly name = "computer" as const;
  async runCodingTask(): Promise<CodingTaskResult> {
    throw new Error(COMPUTER_PREVIEW_MESSAGE);
  }
}

export function resolveRuntimeName(raw: string | undefined): "sandbox" | "computer" {
  if (raw === undefined || raw === "") return "sandbox";
  if (raw === "sandbox" || raw === "computer") return raw;
  throw new Error(`Unknown RUNTIME ${JSON.stringify(raw)}: expected "sandbox" or "computer".`);
}

/**
 * The harness must reach the adapter that actually runs it: egress is
 * narrowed to the selected harness's host, so running a different one would
 * block its own provider.
 */
export function createRuntimeAdapter(
  name: "sandbox" | "computer",
  harness: AgentHarness = opencodeHarness,
): RuntimeAdapter {
  return name === "computer" ? new ComputerPreviewAdapter() : new SandboxRuntimeAdapter(harness);
}

function failureResult(summary: string, exitCode: number, stderrTail: string): CodingTaskResult {
  return {
    status: "error",
    exitCode,
    stderrTail,
    changedFiles: [],
    diff: "",
    files: [],
    summary: redactSecrets(summary),
  };
}

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(boundTail(message, 2000));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("Run cancelled.");
  }
}

/** Thrown when a streamed OpenCode event line is malformed. */
export { OpenCodeEventError } from "./harness/opencode.js";
export { OpenCodeErrorEvent } from "./harness/opencode.js";
export { buildOpencodeArgv, buildOpencodeConfig, parseOpencodeEvent } from "./harness/opencode.js";

interface OutputStream {
  onData: (stream: "stdout" | "stderr", data: string) => void;
  finish: () => Promise<void>;
}

/**
 * Bridge exec output into progress events. Bounded: at most 256 events are
 * emitted per run, stdout lines drive progress and stderr is only counted.
 * Event parsing is harness-dispatched; error events propagate so the run
 * fails honestly.
 */
function streamProgress(harness: AgentHarness, emit: ProgressEmitter, _signal?: AbortSignal): OutputStream {
  let buffer = "";
  let emitted = 0;
  let pending: Promise<void> = Promise.resolve();
  const emitText = (text: string) => {
    if (emitted >= MAX_PROGRESS_EVENTS) return;
    emitted += 1;
    pending = pending.then(() =>
      emit({
        phase: "code",
        message: text,
        fraction: Math.min(0.25 + emitted * 0.05, 0.8),
      }),
    );
  };
  return {
    onData(stream, data) {
      if (stream !== "stdout") return;
      buffer += data;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const text = harness.parseEvent(line);
          if (text) emitText(`[opencode] ${text}`);
        } catch (error) {
          // Error events must propagate so the run fails honestly.
          if (
            error instanceof OpenCodeErrorEventImpl ||
            error instanceof ClaudeCodeErrorEvent ||
            error instanceof CodexErrorEvent
          ) {
            throw error;
          }
          emitText("[opencode] malformed event line (redacted).");
        }
      }
    },
    async finish() {
      buffer = "";
      await pending;
    },
  };
}

function summarizeRun(input: CodingTaskInput, changedFiles: string[], stdoutTail: string): string {
  const header = `OpenCode completed for ${input.repoUrl} (${input.baseBranch}): ${changedFiles.length} changed files.`;
  if (changedFiles.length === 0) {
    return `${header} No file changes detected.`;
  }
  const preview = stdoutTail.trim().slice(-2000);
  return preview ? `${header}\n${preview}` : header;
}

interface CollectedChanges {
  changedFiles: string[];
  diff: string;
  files: Array<{ path: string; content: string | null; encoding: "utf8" | "base64" }>;
}

/** Decode a quoted porcelain path (`\"`, `\\`, `\\n`, `\\t`, `\\ooo`). */
export function unescapePorcelainPath(path: string): string {
  if (!(path.startsWith('"') && path.endsWith('"') && path.length >= 2)) return path;
  const inner = path.slice(1, -1);
  let out = "";
  // Consecutive octal escapes are UTF-8 bytes; decode runs together or
  // multi-byte characters corrupt (café -> cafÃ©).
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length > 0) {
      out += new TextDecoder().decode(new Uint8Array(bytes));
      bytes.length = 0;
    }
  };
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== "\\") {
      flush();
      out += ch;
      continue;
    }
    const next = inner[i + 1];
    if (next === "n") {
      flush();
      out += "\n";
      i += 1;
    } else if (next === "t") {
      flush();
      out += "\t";
      i += 1;
    } else if (next === '"' || next === "\\") {
      flush();
      out += next;
      i += 1;
    } else if (next !== undefined && next >= "0" && next <= "7") {
      let oct = "";
      let j = i + 1;
      while (j < inner.length && oct.length < 3 && inner[j]! >= "0" && inner[j]! <= "7") {
        oct += inner[j];
        j += 1;
      }
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else if (next !== undefined) {
      flush();
      out += next;
      i += 1;
    }
  }
  flush();
  return out;
}

function porcelainPath(rest: string): string {
  const arrow = rest.indexOf(" -> ");
  const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
  return unescapePorcelainPath(path);
}

function porcelainRenameOld(rest: string): string | null {
  const arrow = rest.indexOf(" -> ");
  if (arrow < 0) return null;
  return unescapePorcelainPath(rest.slice(0, arrow));
}

function isSafeRepoPath(path: string): boolean {
  // Only ".." as a whole segment escapes the workdir; "notes..txt" is a legal name.
  return Boolean(path) && !path.split("/").includes("..") && !path.startsWith("/");
}

/** Parse `git status --porcelain` output into repo-relative paths. */
export function parsePorcelainStatus(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const rest = line.slice(3).trim();
    if (!rest) continue;
    const path = porcelainPath(rest);
    if (isSafeRepoPath(path)) paths.push(path);
  }
  return [...new Set(paths)];
}

/** Parse `git status --porcelain` and return deleted (or rename-source) paths. */
function parsePorcelainDeleted(output: string): Set<string> {
  const deleted = new Set<string>();
  for (const line of output.split("\n")) {
    if (line.length < 4) continue;
    const statusCode = line.slice(0, 2);
    const rest = line.slice(3).trim();
    if (!rest) continue;
    const xy = statusCode.replace(" ", "");
    if (xy.includes("D")) {
      const path = porcelainPath(rest);
      if (isSafeRepoPath(path)) deleted.add(path);
    }
    if (xy.includes("R")) {
      const oldPath = porcelainRenameOld(rest);
      if (oldPath && isSafeRepoPath(oldPath)) deleted.add(oldPath);
    }
  }
  return deleted;
}

async function collectChanges(ops: SandboxOps, workdir: string, signal?: AbortSignal): Promise<CollectedChanges> {
  const status = await ops.exec(shellJoin(["git", "status", "--porcelain", "-uall"]), {
    cwd: workdir,
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
  });
  if (status.exitCode !== 0) {
    throw new Error(`git status failed: ${boundTail(status.stderr, 1000)}`);
  }
  const allChanged = parsePorcelainStatus(status.stdout);
  // A tree past the caps must fail the run, not publish a silent partial PR.
  if (allChanged.length > MAX_CAPTURED_FILES) {
    throw new Error(
      `Run changed ${allChanged.length} files; capture limit is ${MAX_CAPTURED_FILES}. ` +
        "Narrow the task or raise MAX_CAPTURED_FILES.",
    );
  }
  const changedFiles = allChanged;
  const deletedFiles = parsePorcelainDeleted(status.stdout);
  // Intent-to-add makes new files show up in the worktree diff.
  // Deleted files are already tracked, so they don't need -N.
  const filesToAdd = changedFiles.filter((path) => !deletedFiles.has(path));
  if (filesToAdd.length > 0) {
    const add = await ops.exec(
      ["git", "add", "-N", "--", ...filesToAdd].map(shellQuote).join(" "),
      { cwd: workdir, timeoutMs: GIT_TIMEOUT_MS, signal },
    );
    if (add.exitCode !== 0) {
      throw new Error(`git add failed: ${boundTail(add.stderr, 1000)}`);
    }
  }
  const diffResult = await ops.exec(shellJoin(["git", "diff", "--", "."]), {
    cwd: workdir,
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
  });
  if (diffResult.exitCode !== 0) {
    throw new Error(`git diff failed: ${boundTail(diffResult.stderr, 1000)}`);
  }
  const diff = boundTail(diffResult.stdout, MAX_DIFF_CHARS);

  const files: CollectedChanges["files"] = [];
  let totalChars = 0;
  for (const path of changedFiles) {
    if (deletedFiles.has(path)) continue;
    const fullPath = `${workdir}/${path}`;
    // The ops layer enforces maxBytes and throws instead of truncating, so a
    // captured file is always complete or the whole run reports the error.
    const read = await ops.readFile(fullPath, {
      maxBytes: MAX_FILE_CHARS,
      signal,
    });
    const content = read.content;
    if (read.kind === "utf8") {
      totalChars += content.length;
    } else {
      totalChars += Math.ceil(content.length * 3 / 4);
    }
    if (totalChars > MAX_TOTAL_FILE_CHARS) {
      throw new Error(
        "Captured file content exceeds MAX_TOTAL_FILE_CHARS; refusing to publish a partial tree.",
      );
    }
    files.push({ path, content, encoding: read.kind });
  }
  // Deletions and rename sources are not on disk; a null-content entry is what
  // removes them from the published tree (src/github.ts).
  for (const path of deletedFiles) {
    files.push({ path, content: null, encoding: "utf8" });
  }
  return { changedFiles, diff, files };
}
