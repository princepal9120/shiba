/**
 * Sandbox coding sub-agent. It receives an explicit structured envelope
 * from the parent (never scraped prose), runs the deterministic sandbox
 * flow, streams progress, and returns a structured result envelope.
 * It makes no model calls of its own.
 */
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getSandboxInstance } from "../sandbox/provider.js";
import type { SandboxSelectionContext } from "../sandbox/selection.js";
import type { SandboxInstance } from "@shiba/sandbox";
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
import type { EgressOverride } from "../harness/types.js";
import { assertHarnessAuthorized } from "../auth/index.js";
import {
  formatAgentResult,
  parseAgentToolInput,
  type CodingTaskInput,
  type CodingTaskResult,
} from "../opencode-input.js";
import {
  createRuntimeAdapter,
  LOCAL_DISPATCH_MESSAGE,
  resolveRuntimeName,
  type LocalDispatchClient,
  type ProgressEvent,
  type SandboxOps,
} from "../runtime.js";
import { LOCAL_RUNTIME_FLAG, verifyStandinEnabled } from "@shiba/shared";
import {
  formatStandInReviewOutput,
  isReviewerStandIn,
  runVerifyStandInTask,
} from "../verify-standin.js";
import { localDispatchStub } from "../local-dispatch.js";
import { chatGptAuthStub } from "../chatgpt-auth-do.js";
import { codexDeviceAuthDeploymentEnabled } from "../harness/codex-device-auth.js";
import { readUserOpenAiAuthMode } from "../subscription-device-auth.js";
import { modelCredentialKeyConfigured } from "../subscription-credentials.js";
import { acquireSandboxOps } from "../sandbox/lifecycle.js";
import { HARNESS_RETRY, withRetry } from "../harness/retry.js";
import type { RunSignal } from "@shiba/shared";
import { boundTail, parseGitHubRepoUrl, redactSecrets } from "../security.js";
import { captureBrowserE2eEvidence, formatBrowserE2ePrSection } from "../browser-e2e/capture.js";
import { captureRunPreview } from "../screenshot.js";
import { guardRunEnvLeak, openRunEnv, runEnvDiffLeakName, runEnvScrubber } from "../run-env-seal.js";
import { postSlackMessage } from "../slack.js";
import { SlackProgressReporter } from "../slack-persona.js";
import { messageText, renderRunTranscript } from "../transcript.js";

export async function pinSandboxEgress(
  env: Env,
  sandboxId: string,
  repoUrl: string,
  egressHosts?: string[],
  egressOverrides?: EgressOverride[],
  selection: SandboxSelectionContext = {},
): Promise<void> {
  const instance = await getSandboxInstance(env, sandboxId, selection);
  if (!instance.pinEgress) {
    throw new Error(
      `Sandbox provider "${env.SHIBA_SANDBOX_PROVIDER ?? "cloudflare"}" cannot pin egress at the edge.`,
    );
  }
  const outboundByHost =
    egressOverrides && egressOverrides.length > 0
      ? Object.fromEntries(
          egressOverrides.map((o) => [
            o.host,
            { handler: o.handler, ...(o.params ? { params: o.params } : {}) },
          ]),
        )
      : undefined;
  const { owner, repo } = parseGitHubRepoUrl(repoUrl);
  await instance.pinEgress({
    allowedHosts: egressHosts ?? [],
    ...(outboundByHost ? { outboundByHost } : {}),
    githubRepoPath: `/${owner}/${repo}`,
    ...(selection.orgId ? { orgId: selection.orgId } : {}),
  });
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

export function createSandboxOps(
  env: Env,
  sandboxId: string,
  egressHosts?: string[],
  egressOverrides?: EgressOverride[],
  selection: SandboxSelectionContext = {},
): SandboxOps {
  let instancePromise: Promise<SandboxInstance> | undefined;
  const instance = () => {
    instancePromise ??= getSandboxInstance(env, sandboxId, selection);
    return instancePromise;
  };
  return {
    async gitCheckout(repoUrl, opts) {
      // The clone runs before anything else, so it is where this run's egress
      // is pinned down: the selected harness's hosts only (T22), and the
      // GitHub credential scoped to this one repo (B6). The pin + clone pair
      // is one retried unit — a half-pinned sandbox must not be reused.
      await withRetry(HARNESS_RETRY, async () => {
        await pinSandboxEgress(env, sandboxId, repoUrl, egressHosts, egressOverrides, selection);
        await (await instance()).gitCheckout(repoUrl, { branch: opts.branch, targetDir: opts.targetDir });
      });
    },
    async writeFile(path, content) {
      await (await instance()).writeFile(path, content);
    },
    async exec(command, opts) {
      opts?.signal?.throwIfAborted();
      const execPromise = (await instance()).exec(command, {
        cwd: opts?.cwd,
        timeoutMs: opts?.timeoutMs,
        env: opts?.env,
        onOutput: opts?.onOutput,
      });
      if (!opts?.signal) return execPromise;
      if (opts.signal.aborted) {
        execPromise.catch(() => {});
        throw new Error("Run cancelled.");
      }
      return Promise.race([
        execPromise,
        new Promise<never>((_, reject) => {
          const onAbort = () => {
            execPromise.catch(() => {});
            reject(new Error("Run cancelled."));
          };
          opts.signal!.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    },
    async readFile(path, opts) {
      return (await instance()).readFile(path, opts);
    },
  };
}

/**
 * T51: the production LocalDispatchClient — adapter requests ride the
 * intra-deployment DO stub; the bearer-token front door is for the
 * operator daemon only, so these calls carry no credential.
 */
function workerLocalDispatchClient(env: Env): LocalDispatchClient {
  const stub = () => localDispatchStub(env);
  return {
    async dispatch(envelope, targetMachineId) {
      const res = await stub().fetch(new Request("https://local-dispatch/dispatch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope, ...(targetMachineId !== undefined ? { targetMachineId } : {}) }),
      }));
      if (!res.ok) throw new Error(`dispatch: ${res.status} ${await res.text()}`);
    },
    async status(sandboxId) {
      const res = await stub().fetch(new Request(`https://local-dispatch/status?sandboxId=${encodeURIComponent(sandboxId)}`));
      if (!res.ok) throw new Error(`status: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async cancel(sandboxId) {
      await stub().fetch(new Request("https://local-dispatch/cancel", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sandboxId }),
      }));
    },
  };
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
        // T42: the adapter and the publish step append milestones here;
        // the result envelope carries them back to the orchestrator.
        const runSignals: RunSignal[] = [];
        const noteSignal = (kind: RunSignal["kind"], detail?: string) => {
          runSignals.push(detail !== undefined ? { kind, at: Date.now(), detail } : { kind, at: Date.now() });
        };
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
          let result: CodingTaskResult;
          if (verifyStandinEnabled(this.env)) {
            result = await runVerifyStandInTask(input, emit);
          } else {
            const harness = resolveHarness(input.harness ?? this.env.AGENT_HARNESS, this.env);
            // T48: subscription-authed harnesses must have a succeeded auth
            // flow before a container spins up — assert at the admission seam,
            // after the harness is resolved, before any sandbox work starts.
            await assertHarnessAuthorized(this.env, harness, input);
            // T51: the approved input's runtime wins over the deployment's
            // RUNTIME default. "local" needs both the deployment flag and the
            // dispatch mailbox; every other surface refused it at intake, and
            // this is the last place a forged envelope could reach.
            const runtimeName = input.runtime ?? resolveRuntimeName(this.env.RUNTIME);
            let adapter;
            if (runtimeName === "local") {
              if (this.env[LOCAL_RUNTIME_FLAG] !== "1") {
                throw new Error(LOCAL_DISPATCH_MESSAGE);
              }
              adapter = createRuntimeAdapter("local", harness, {
                client: workerLocalDispatchClient(this.env),
              });
            } else {
              adapter = createRuntimeAdapter(runtimeName, harness);
            }
            let runInput = input;
            if (harness.name === "codex-subscription" && input.initiatorUserId) {
              const deviceAuth =
                codexDeviceAuthDeploymentEnabled(this.env) &&
                (await readUserOpenAiAuthMode(this.env, input.initiatorUserId)) === "device-auth";
              if (deviceAuth) {
                runInput = { ...input, codexAuthMode: "device-auth" };
              } else if (this.env.ChatGptAuth && modelCredentialKeyConfigured(this.env)) {
                const accessResponse = await chatGptAuthStub(this.env, input.initiatorUserId).fetch(
                  "https://chatgpt-auth.internal/access",
                );
                if (!accessResponse.ok) {
                  const body = (await accessResponse.json().catch(() => null)) as { error?: string } | null;
                  throw new Error(body?.error ?? "ChatGPT plan access is not available for this user.");
                }
                const access = (await accessResponse.json()) as {
                  accessToken?: unknown;
                  threadId?: string | null;
                  planUsageEnabled?: boolean;
                };
                if (typeof access.accessToken !== "string" || access.accessToken === "" || access.planUsageEnabled === false) {
                  throw new Error(
                    access.planUsageEnabled === false
                      ? "ChatGPT is connected but plan usage is disabled. Re-consent in Providers."
                      : "ChatGPT plan access is not available for this user.",
                  );
                }
                runInput = {
                  ...input,
                  ...(access.threadId ? { chatgptThreadId: access.threadId } : {}),
                };
              }
            }
            // T68: a wrong owner or digest fails to open — the run fails rather than running unapproved env.
            const runEnv =
              runInput.envSealed === undefined
                ? undefined
                : await openRunEnv(this.env, runInput.envOwner ?? "", runInput.envSealed, runInput.envDigest ?? "");
            this.envScrub = runEnv !== undefined ? runEnvScrubber(runEnv) : null;
            const hosts = allowedHostsFor(harness, runInput.codingModel, runInput);
            const overrides = harness.egressOverrides?.(runInput);
            const effectiveOrgId = runInput.orgId || "self-hosted";
            const ops = await acquireSandboxOps(this.env, runInput.sandboxId, hosts, overrides, {
              orgId: effectiveOrgId,
              taskProviderId: runInput.sandboxProvider,
            });
            result = await adapter.runCodingTask(ops, runInput, emit, {
              signal,
              signals: runSignals,
              ...(runEnv !== undefined && this.envScrub !== null ? { env: runEnv, scrub: this.envScrub } : {}),
              // T44: an oversize diff lands in R2 instead of being truncated
              // away — the settle receipt carries this key.
              exportDiff: async (diff) => {
                const leaked = runEnv !== undefined ? runEnvDiffLeakName(diff, runEnv) : undefined;
                if (leaked !== undefined) {
                  throw new Error(`The change contains the value of approved environment variable ${leaked}; refusing to export it.`);
                }
                const key = `diffs/${input.sandboxId}.patch`;
                await this.env.ATTACHMENTS.put(key, diff, { httpMetadata: { contentType: "text/plain" } });
                return key;
              },
            });
            if (runEnv !== undefined) result = guardRunEnvLeak(result, runEnv);
          }
          checkCancelled();
          // UNINTERRUPTIBLE: publish + result commit. Once the remote PR write
          // starts, an abort must not lose the outcome — a fake-failed real PR
          // is worse than a late commit. The only abort check inside
          // publishResult sits before the first remote write.
          let pullUrl: string | undefined;
          let screenshotUrl: string | undefined;
          let browserE2eManifestUrl: string | undefined;
          if (result.status === "completed" && input.publishPullRequest) {
            const published = await this.publishResult(input, result, signal);
            pullUrl = published.pullUrl;
            screenshotUrl = published.screenshotUrl;
            browserE2eManifestUrl = published.browserE2eManifestUrl;
            if (screenshotUrl) noteSignal("screenshot.captured", screenshotUrl);
            if (browserE2eManifestUrl) {
              noteSignal("e2e.completed", browserE2eManifestUrl);
            }
            noteSignal("pr.opened", pullUrl);
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
          if (verifyStandinEnabled(this.env) && isReviewerStandIn(input)) {
            write(formatStandInReviewOutput({
              ...safeResult,
              findings: (result as CodingTaskResult & { findings?: unknown[] }).findings ?? [],
            }));
          } else {
            write(formatAgentResult({
              ...safeResult,
              ...(pullUrl ? { pullUrl } : {}),
              ...(screenshotUrl ? { screenshotUrl } : {}),
              ...(browserE2eManifestUrl ? { browserE2eManifestUrl } : {}),
              signals: runSignals,
            }));
          }
          writer.write({ type: "text-end", id });
          if (safeResult.status === "error") writer.write({ type: "error", errorText: safeResult.summary });
          writer.write({ type: "finish", finishReason: safeResult.status === "error" ? "error" : "stop" });
        } catch (error) {
          const summary = signal?.aborted ? "Run cancelled." : this.safeText(error instanceof Error ? error.message : String(error), 4000);
          const result: CodingTaskResult = {
            status: "error", exitCode: -1, summary,
            stderrTail: "", changedFiles: [], diff: "", files: [],
            // Partial signals ride the error envelope too — a waiter's
            // missing milestone names the phase that never completed.
            signals: runSignals,
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

  /** T68: set once the run's sealed env opens; every safeText output passes through it. */
  private envScrub: ((text: string) => string) | null = null;

  private safeText(text: string, maxChars: number): string {
    const token = this.env.GITHUB_TOKEN;
    const withoutToken = token ? text.split(token).join("[redacted]") : text;
    const withoutEnv = this.envScrub ? this.envScrub(withoutToken) : withoutToken;
    return boundTail(redactSecrets(withoutEnv), maxChars);
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
      ...(result.testEvidence
        ? {
            testEvidence: {
              command: this.safeText(result.testEvidence.command, 200),
              exitCode: result.testEvidence.exitCode,
              outputTail: this.safeText(result.testEvidence.outputTail, 8000),
            },
          }
        : {}),
    };
  }

  private async publishResult(
    input: CodingTaskInput,
    result: CodingTaskResult,
    signal?: AbortSignal,
  ): Promise<{ pullUrl: string; screenshotUrl?: string; browserE2eManifestUrl?: string }> {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error("publishPullRequest was requested but GITHUB_TOKEN is not configured.");
    signal?.throwIfAborted();
    // T33: render the finished workdir through the preview port and screenshot
    // it BEFORE the PR is written so the links land in the body. captureRunPreview
    // is fail-safe — it returns null rather than throwing, so a Browser Rendering
    // or sandbox problem can never lose a publish.
    const capture = verifyStandinEnabled(this.env)
      ? null
      : await captureRunPreview(this.env, { sandboxId: input.sandboxId });
    const e2eCapture = verifyStandinEnabled(this.env)
      ? null
      : await captureBrowserE2eEvidence(this.env, { sandboxId: input.sandboxId });
    const bodyLines = [
      this.safeText(result.summary, 4000),
      "",
      `Sandbox: ${input.sandboxId}`,
    ];
    // T46 proof section: a reviewer verifies from the PR body without reading
    // the diff line by line. The stored screenshot is the durable proof; the
    // tokenized exposePort URL is a bearer credential and never leaves the
    // Worker (T33). When no capture exists (no servable app), the body says
    // so instead of implying proof that isn't there.
    if (capture?.screenshotUrl) bodyLines.push("", `[Preview screenshot](${capture.screenshotUrl})`);
    else bodyLines.push("", "No preview captured — this change has no servable app; verify via the diff and test evidence.");
    if (e2eCapture?.manifestUrl && e2eCapture.manifest.ok) {
      bodyLines.push(formatBrowserE2ePrSection(e2eCapture));
    }
    if (result.testEvidence) {
      bodyLines.push(
        "",
        `**Test evidence:** \`${this.safeText(result.testEvidence.command, 200)}\` → exit ${result.testEvidence.exitCode}`,
        "```",
        this.safeText(result.testEvidence.outputTail, 4000),
        "```",
      );
    }
    // The screenshot link is served by this Worker behind the read-API auth gate.
    const published = await publishFilesAsPullRequest(
      {
        repoUrl: input.repoUrl,
        baseBranch: input.baseBranch,
        newBranch: `shiba/${input.sandboxId}`,
        title: `AI Coworker: ${this.safeText(input.task, 80)}`,
        body: bodyLines.join("\n"),
        files: result.files,
        token,
        message: `AI Coworker: ${this.safeText(input.task, 120)}`,
      },
      {
        ...(this.env.GITHUB_API_BASE ? { apiBase: this.env.GITHUB_API_BASE } : {}),
      },
    );
    // Board sync is best-effort and chains up to ~150s of GraphQL calls —
    // never let it delay the run's terminal transition or PR post-back.
    // this.ctx is absent on test stubs, hence the optional call.
    (this.ctx as DurableObjectState | undefined)?.waitUntil?.(
      this.syncProjectBoard(input.repoUrl, published.pullNumber),
    );
    return {
      pullUrl: published.pullUrl,
      ...(capture?.screenshotUrl ? { screenshotUrl: capture.screenshotUrl } : {}),
      ...(e2eCapture?.manifestUrl && e2eCapture.manifest.ok
        ? { browserE2eManifestUrl: e2eCapture.manifestUrl }
        : {}),
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
