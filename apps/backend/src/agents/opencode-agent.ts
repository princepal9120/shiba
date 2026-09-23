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
      const result = await sandbox.exec(command, {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs,
        env: opts?.env,
        signal: opts?.signal,
        stream: opts?.onOutput !== undefined,
        onOutput: opts?.onOutput,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 0,
      };
    },
    async readFile(path, opts) {
      opts?.signal?.throwIfAborted();
      const stream = await sandbox.readFileStream(path);
      const bytes = await collectStream(stream, opts?.maxBytes, opts?.signal);
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
  // The pipe interrupts a stalled read as well as cancelling the SDK stream.
  const source = signal ? stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(), { signal }) : stream;
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
        const emit = async (event: ProgressEvent) => {
          checkCancelled();
          if (progressCount >= 100 || progressChars >= 20_000) return;
          const message = this.safeText(event.message, Math.min(2000, 20_000 - progressChars));
          const phase = this.safeText(event.phase, 40);
          progressChars += message.length;
          progressCount++;
          write(`[${phase}] ${message}`);
          await this.reportProgress({ message, fraction: event.fraction, phase });
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
          if (result.status === "completed" && input.publishPullRequest) {
            pullUrl = await this.publishResult(input, result, signal);
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
          write(formatAgentResult(pullUrl ? { ...safeResult, pullUrl } : safeResult));
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

  private async publishResult(input: CodingTaskInput, result: CodingTaskResult, signal?: AbortSignal): Promise<string> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error("publishPullRequest was requested but GITHUB_TOKEN is not configured.");
    signal?.throwIfAborted();
    const published = await publishFilesAsPullRequest({
      repoUrl: input.repoUrl,
      baseBranch: input.baseBranch,
      newBranch: `shiba-ai-coworker/${input.sandboxId}`,
      title: `AI Coworker: ${this.safeText(input.task, 80)}`,
      body: `${this.safeText(result.summary, 4000)}\n\nSandbox: ${input.sandboxId}`,
      files: result.files,
      token,
      message: `AI Coworker: ${this.safeText(input.task, 120)}`,
    });
    return published.pullUrl;
  }
}
