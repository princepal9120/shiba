/**
 * Sandbox coding sub-agent. It receives an explicit structured envelope
 * from the parent (never scraped prose), runs the deterministic sandbox
 * flow, streams progress, and returns a structured result envelope.
 * It makes no model calls of its own.
 */
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getSandbox, streamFile } from "@cloudflare/sandbox";
import {
  createUIMessageStream,
  createUIMessageStreamResponse,
  type GenerateTextOnFinishCallback,
  type ToolSet,
} from "ai";
import type { Env } from "../env.js";
import { publishFilesAsPullRequest } from "../github.js";
import {
  addPullToProject,
  pullRequestNodeId,
  resolveProject,
  setItemStatus,
} from "../github-project.js";
import { allowedHostsFor, resolveHarness } from "../harness/index.js";
import {
  formatAgentResult,
  parseAgentToolInput,
  type CodingTaskInput,
  type CodingTaskResult,
} from "../opencode-input.js";
import {
  createRuntimeAdapter,
  resolveRuntimeName,
  type ProgressEvent,
  type SandboxOps,
} from "../runtime.js";
import { HARNESS_RETRY, withRetry } from "../harness/retry.js";
import { boundTail, parseGitHubRepoUrl, redactSecrets } from "../security.js";
import { captureRunPreview } from "../screenshot.js";
import { postSlackMessage } from "../slack.js";
import { SlackProgressReporter } from "../slack-persona.js";
import { messageText, renderRunTranscript } from "../transcript.js";

export async function pinSandboxEgress(
  env: Env,
  sandboxId: string,
  repoUrl: string,
  egressHosts?: string[],
): Promise<void> {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  if (egressHosts && egressHosts.length > 0) {
    await sandbox.approveHarnessEgress(egressHosts);
  }
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  await sandbox.approveRepoScope(`/${owner}/${repo}`);
}

/**
 * Progress relay for Slack-originated runs: the thread ids come frozen in
 * the task envelope, the bot token from env. No thread or no token means
 * no relay — the run itself is unaffected either way.
 */
function createSlackProgress(env: Env, thread?: CodingTaskInput["slackThread"]): SlackProgressReporter | null {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!thread || !token) return null;
  return new SlackProgressReporter((text) =>
    postSlackMessage(token, { channel: thread.channelId, threadTs: thread.threadTs, text }),
  );
}

export function createSandboxOps(env: Env, sandboxId: string, egressHosts?: string[]): SandboxOps {
  const sandbox = getSandbox(env.Sandbox, sandboxId);
  return {
    async gitCheckout(repoUrl, opts) {
      // The clone runs before anything else, so it is where this run's egress
      // is pinned down: the selected harness's hosts only (T22), and the
      // GitHub credential scoped to this one repo (B6). The pin + clone pair
      // is one retried unit — a half-pinned sandbox must not be reused.
      await withRetry(HARNESS_RETRY, async () => {
        await pinSandboxEgress(env, sandboxId, repoUrl, egressHosts);
        await sandbox.gitCheckout(repoUrl, { branch: opts.branch, targetDir: opts.targetDir });
      });
    },
    async writeFile(path, content) {
      await sandbox.writeFile(path, content);
    },
    async exec(command, opts) {
      opts?.signal?.throwIfAborted();
      // AbortSignal cannot cross the sandbox RPC boundary; the exec timeout
      // bounds the remote process, and abort is raced in locally instead.
      const execPromise = sandbox.exec(command, {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs,
        env: opts?.env,
        stream: opts?.onOutput !== undefined,
        onOutput: opts?.onOutput,
      });
      const result = opts?.signal
        ? await Promise.race([
            execPromise,
            new Promise<never>((_, reject) =>
              opts.signal!.addEventListener(
                "abort",
                () => {
                  execPromise.catch(() => {});
                  reject(new Error("Run cancelled."));
                },
                { once: true },
              ),
            ),
          ])
        : await execPromise;
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    async readFile(path, opts) {
      opts?.signal?.throwIfAborted();
      let stream;
      try {
        stream = await sandbox.readFileStream(path);
      } catch (error) {
        throw new Error(`readFileStream RPC failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      let bytes;
      try {
        bytes = await collectStream(stream, opts?.maxBytes, opts?.signal);
      } catch (error) {
        throw new Error(`collectStream failed for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const decoded = tryDecodeUtf8(bytes);
      if (decoded !== null) {
        return { kind: "utf8", content: decoded };
      }
      return { kind: "base64", content: bytesToBase64(bytes) };
    },
  };
}

async function collectStream(stream: ReadableStream<Uint8Array>, maxBytes = 500_000, signal?: AbortSignal): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  // pipeThrough({ signal }) rejects non-native AbortSignals with an illegal
  // invocation; the for-await's throwIfAborted covers cancellation instead.
  const source = signal ? stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>()) : stream;
  // readFileStream is SSE, not raw file bytes. Decode before collecting.
  for await (const chunk of streamFile(source)) {
    signal?.throwIfAborted();
    const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
    total += bytes.length;
    if (total > maxBytes) throw new Error(`Captured file exceeds the ${maxBytes}-byte limit.`);
    chunks.push(bytes);
  }
  signal?.throwIfAborted();
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function tryDecodeUtf8(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export class OpenCodeAgent extends AIChatAgent<Env> {
  override async onChatMessage(
    _onFinish: GenerateTextOnFinishCallback<ToolSet>,
    options?: OnChatMessageOptions,
  ): Promise<Response | undefined> {
    const signal = options?.abortSignal;
    const checkCancelled = () => {
      if (signal?.aborted) throw new Error("Run cancelled.");
    };
    // ai-chat 0.12 persists the returned SSE in _reply; manually persisting
    // here would duplicate the assistant message or race the turn's save.
    const stream = createUIMessageStream({
      onError: (error) => this.safeText(error instanceof Error ? error.message : String(error), 4000),
      execute: async ({ writer }) => {
        const id = "run-log";
        writer.write({ type: "start" });
        writer.write({ type: "text-start", id });
        const write = (text: string) => writer.write({ type: "text-delta", id, delta: `${text}\n` });
        let progressChars = 0;
        let progressCount = 0;
        let slackProgress: SlackProgressReporter | null = null;
        const emit = async (event: ProgressEvent) => {
          checkCancelled();
          if (progressCount >= 100 || progressChars >= 20_000) return;
          const message = this.safeText(event.message, Math.min(2000, 20_000 - progressChars));
          const phase = this.safeText(event.phase, 40);
          progressChars += message.length;
          progressCount++;
          write(`[${phase}] ${message}`);
          await this.reportProgress({ message, fraction: event.fraction, phase });
          // Coworker cadence in the same Slack thread — the reporter
          // throttles and swallows its own failures, so this can't stall
          // or fail the run. Safe values only: raw event text can carry
          // secrets that safeText already stripped for the dashboard.
          void slackProgress?.onEvent({ phase, message }).catch(() => undefined);
        };
        try {
          checkCancelled();
          const input = parseAgentToolInput(this.messages.map((message) => ({
            role: message.role,
            text: messageText(message),
          })));
          if (input.publishPullRequest && !this.env.GITHUB_TOKEN) {
            throw new Error("publishPullRequest was requested but GITHUB_TOKEN is not configured.");
          }
          // The approval froze the harness (and model) for this run. The
          // deployment default is only the fallback for pre-harness inputs.
          slackProgress = createSlackProgress(this.env, input.slackThread);
          const harness = resolveHarness(input.harness ?? this.env.AGENT_HARNESS);
          const adapter = createRuntimeAdapter(resolveRuntimeName(this.env.RUNTIME), harness);
          const hosts = allowedHostsFor(harness, input.codingModel);
          const ops = createSandboxOps(this.env, input.sandboxId, hosts);
          const result = await adapter.runCodingTask(ops, input, emit, { signal });
          checkCancelled();
          // UNINTERRUPTIBLE: publish + result commit. Once the remote PR write
          // starts, an abort must not lose the outcome — a fake-failed real PR
          // is worse than a late commit. The only abort check inside
          // publishResult sits before the first remote write.
          let pullUrl: string | undefined;
          let screenshotUrl: string | undefined;
          if (result.status === "completed" && input.publishPullRequest) {
            const published = await this.publishResult(input, result, signal);
            pullUrl = published.pullUrl;
            screenshotUrl = published.screenshotUrl;
          }
          const safeResult = this.uiResult(result);
          // The transcript commit below is part of the same UNINTERRUPTIBLE
          // span: no abort checks between publish and these writes.
          const safeInput = {
            ...input,
            task: this.safeText(input.task, 4000),
            repoUrl: this.safeText(input.repoUrl, 2048),
            baseBranch: this.safeText(input.baseBranch, 256),
            sandboxId: this.safeText(input.sandboxId, 63),
          };
          // Progress was already streamed. Never repeat it or retain a second copy.
          for (const line of renderRunTranscript({ input: safeInput, progress: [], result: safeResult, pullUrl })) {
            write(this.safeText(line, 24_000));
          }
          // pullUrl rides the envelope: the parent's text scrape of the
          // transcript is only a legacy fallback, never the source of truth.
          write(formatAgentResult({
            ...safeResult,
            ...(pullUrl ? { pullUrl } : {}),
            ...(screenshotUrl ? { screenshotUrl } : {}),
          }));
          writer.write({ type: "text-end", id });
          if (safeResult.status === "error") writer.write({ type: "error", errorText: safeResult.summary });
          writer.write({ type: "finish", finishReason: safeResult.status === "error" ? "error" : "stop" });
        } catch (error) {
          const summary = signal?.aborted ? "Run cancelled." : this.safeText(error instanceof Error ? error.message : String(error), 4000);
          const result: CodingTaskResult = {
            status: "error", exitCode: -1, summary,
            stderrTail: "", changedFiles: [], diff: "", files: [],
          };
          write(`Failed: ${summary}`);
          write(formatAgentResult(result));
          writer.write({ type: "text-end", id });
          writer.write({ type: "error", errorText: summary });
          writer.write({ type: "finish", finishReason: "error" });
        }
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  private safeText(text: string, maxChars: number): string {
    const token = this.env.GITHUB_TOKEN;
    const withoutToken = token ? text.split(token).join("[redacted]") : text;
    return boundTail(redactSecrets(withoutToken), maxChars);
  }

  private uiResult(result: CodingTaskResult): CodingTaskResult {
    return {
      status: result.status,
      exitCode: result.exitCode,
      summary: this.safeText(result.summary, 4000),
      stderrTail: this.safeText(result.stderrTail, 8000),
      changedFiles: result.changedFiles.slice(0, 50).map((path) => this.safeText(path, 1024)),
      diff: this.safeText(result.diff, 20_000),
      files: [],
    };
  }

  private async publishResult(
    input: CodingTaskInput,
    result: CodingTaskResult,
    signal?: AbortSignal,
  ): Promise<{ pullUrl: string; screenshotUrl?: string }> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error("publishPullRequest was requested but GITHUB_TOKEN is not configured.");
    signal?.throwIfAborted();
    // T33: render the finished workdir through the preview port and screenshot
    // it BEFORE the PR is written so the links land in the body. captureRunPreview
    // is fail-safe — it returns null rather than throwing, so a Browser Rendering
    // or sandbox problem can never lose a publish.
    const capture = await captureRunPreview(this.env, { sandboxId: input.sandboxId });
    const bodyLines = [
      this.safeText(result.summary, 4000),
      "",
      `Sandbox: ${input.sandboxId}`,
    ];
    if (capture?.screenshotUrl) bodyLines.push("", `[Preview screenshot](${capture.screenshotUrl})`);
    // The screenshot link is served by this Worker behind the read-API auth gate.
    const published = await publishFilesAsPullRequest({
      repoUrl: input.repoUrl,
      baseBranch: input.baseBranch,
      newBranch: `shiba/${input.sandboxId}`,
      title: `AI Coworker: ${this.safeText(input.task, 80)}`,
      body: bodyLines.join("\n"),
      files: result.files,
      token,
      message: `AI Coworker: ${this.safeText(input.task, 120)}`,
    });
    // Board sync is best-effort and chains up to ~150s of GraphQL calls —
    // never let it delay the run's terminal transition or PR post-back.
    // this.ctx is absent on test stubs, hence the optional call.
    (this.ctx as DurableObjectState | undefined)?.waitUntil?.(
      this.syncProjectBoard(input.repoUrl, published.pullNumber),
    );
    return {
      pullUrl: published.pullUrl,
      ...(capture?.screenshotUrl ? { screenshotUrl: capture.screenshotUrl } : {}),
    };
  }

  // Board sync is best-effort: a missing PAT or a broken board never fails a published PR.
  private async syncProjectBoard(repoUrl: string, pullNumber: number): Promise<void> {
    const token = this.env.GITHUB_PROJECT_TOKEN;
    const projectNumber = this.env.GITHUB_PROJECT_NUMBER;
    if (!token || !projectNumber) return;
    try {
      const { owner } = parseGitHubRepoUrl(repoUrl);
      const board = await resolveProject(owner, Number(projectNumber), token);
      const nodeId = await pullRequestNodeId(repoUrl, pullNumber, token);
      const itemId = await addPullToProject(board.projectId, nodeId, token);
      await setItemStatus(board.projectId, itemId, "In review", token);
    } catch (error) {
      console.warn(`project board sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
