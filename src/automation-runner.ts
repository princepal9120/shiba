/**
 * Production fire path for automations (PLAN T18–T20).
 *
 * Match → optional TypeSafe/Workers AI `run_when` → T20 safety → queue a
 * pending approval (or auto-approve when unattended is granted). Skips are
 * recorded; nothing fires silently.
 */
import {
  authorizeAutomationRun,
  automationsEnabled,
  evaluateRunWhen,
  matchAutomationEvent,
  recordSkip,
  recordTrigger,
  type Automation,
  type AutomationMatchEvent,
  type GitHubAutomationEvent,
  type RunWhenAi,
  type SlackAutomationEvent,
  type TypeSafeNoulFetch,
} from "./automations.js";
import { clampBurstWindowSeconds, DEFAULT_BURST_WINDOW_SECONDS } from "./slack-context.js";

export const AUTOMATIONS_DO_NAME = "default";

export interface QueueAutomationRunInput {
  repoUrl: string;
  task: string;
  publishPullRequest: boolean;
  threadKey: string;
}

export interface FireAutomationDeps {
  ai: RunWhenAi;
  model: string;
  typeSafeApiKey?: string;
  fetchImpl?: TypeSafeNoulFetch;
  nowMs?: number;
  globalEnabled: boolean;
  queueRun: (input: QueueAutomationRunInput) => Promise<{ approvalId: string }>;
  resolveApproval?: (input: {
    threadKey: string;
    approvalId: string;
    approved: boolean;
    decidedBy: string;
  }) => Promise<void>;
}

export interface FireAutomationResult {
  fired: boolean;
  automation: Automation;
  reason: string;
  approvalId?: string;
}

export function summarizeAutomationEvent(event: AutomationMatchEvent): string {
  if (event.kind === "github") {
    return [
      `github ${event.event}${event.action ? `:${event.action}` : ""}`,
      event.repo,
      event.branch,
      event.author,
      (event.labels ?? []).join(","),
    ]
      .filter((part) => part && String(part).length > 0)
      .join(" ");
  }
  if (event.kind === "slack") {
    return `slack ${event.channel ?? ""} ${event.author ?? ""} ${event.text ?? ""}`.trim();
  }
  if (event.kind === "webhook") {
    return "incoming webhook";
  }
  if (event.kind === "schedule") {
    return `schedule tick ${event.nowMs}`;
  }
  return "manual";
}

export function githubWebhookToEvent(
  githubEvent: string,
  body: unknown,
): GitHubAutomationEvent {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const repoObj = typeof record.repository === "object" && record.repository !== null
    ? (record.repository as Record<string, unknown>)
    : {};
  const pr = typeof record.pull_request === "object" && record.pull_request !== null
    ? (record.pull_request as Record<string, unknown>)
    : null;
  const issue = typeof record.issue === "object" && record.issue !== null
    ? (record.issue as Record<string, unknown>)
    : null;
  const sender = typeof record.sender === "object" && record.sender !== null
    ? (record.sender as Record<string, unknown>)
    : {};
  const user = (pr ?? issue)?.user;
  const userLogin =
    typeof user === "object" && user !== null && typeof (user as { login?: unknown }).login === "string"
      ? (user as { login: string }).login
      : typeof sender.login === "string"
        ? sender.login
        : undefined;
  const labelsRaw = (pr ?? issue)?.labels;
  const labels = Array.isArray(labelsRaw)
    ? labelsRaw.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (typeof entry === "object" && entry !== null && typeof (entry as { name?: unknown }).name === "string") {
          return [(entry as { name: string }).name];
        }
        return [];
      })
    : undefined;
  const ref = typeof record.ref === "string" ? record.ref : undefined;
  const prHead = pr && typeof pr.head === "object" && pr.head !== null
    ? (pr.head as { ref?: unknown }).ref
    : undefined;
  const branch =
    typeof prHead === "string"
      ? prHead
      : ref?.startsWith("refs/heads/")
        ? ref.slice("refs/heads/".length)
        : undefined;
  return {
    event: githubEvent,
    action: typeof record.action === "string" ? record.action : undefined,
    repo: typeof repoObj.full_name === "string" ? repoObj.full_name : undefined,
    branch,
    author: userLogin,
    labels,
  };
}

export function slackEventToAutomation(body: unknown): SlackAutomationEvent {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const event = typeof record.event === "object" && record.event !== null
    ? (record.event as Record<string, unknown>)
    : record;
  return {
    channel: typeof event.channel === "string" ? event.channel : undefined,
    author: typeof event.user === "string" ? event.user : undefined,
    text: typeof event.text === "string" ? event.text : undefined,
  };
}

export function automationThreadKey(automationId: string): string {
  return `automation:${automationId}`;
}

/**
 * One automation, one event. Match, gate, authorize, then queue (and
 * auto-approve only when T20 unattended is granted).
 */
export async function fireAutomation(
  automation: Automation,
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
): Promise<FireAutomationResult> {
  const nowMs = deps.nowMs ?? Date.now();
  const matched = matchAutomationEvent(automation, event);
  if (!matched) {
    return { fired: false, automation, reason: "No matching trigger." };
  }

  // One run per burst (PLAN T13): a matched Slack event inside the trigger's
  // burst window of the previous firing is suppressed — cheap check before
  // any run_when model call.
  if (
    matched.trigger.kind === "slack" &&
    automation.lastTriggeredAt !== undefined
  ) {
    const windowMs =
      clampBurstWindowSeconds(matched.trigger.burstWindowSeconds ?? DEFAULT_BURST_WINDOW_SECONDS) *
      1000;
    if (nowMs - automation.lastTriggeredAt < windowMs) {
      const skipped = recordSkip(automation, "Burst window: a matching run already fired.", nowMs);
      return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? "burst" };
    }
  }

  const runWhen = matched.trigger.runWhen?.trim() ?? "";
  if (runWhen) {
    const verdict = await evaluateRunWhen(
      deps.ai,
      deps.model,
      runWhen,
      summarizeAutomationEvent(event),
      deps.typeSafeApiKey,
      deps.fetchImpl,
    );
    if (!verdict.run) {
      const skipped = recordSkip(automation, verdict.reason, nowMs);
      return { fired: false, automation: skipped, reason: verdict.reason };
    }
  }

  const request = { publishPullRequest: true };
  const auth = authorizeAutomationRun(automation, request, nowMs, deps.globalEnabled);
  if (!auth.allowed) {
    const skipped = recordSkip(automation, auth.reason, nowMs);
    return { fired: false, automation: skipped, reason: auth.reason };
  }

  const threadKey = automationThreadKey(automation.id);
  try {
    const queued = await deps.queueRun({
      repoUrl: automation.repoUrl,
      task: automation.prompt,
      publishPullRequest: true,
      threadKey,
    });
    const next = recordTrigger(automation, nowMs);
    if (!auth.requiresApproval) {
      if (!deps.resolveApproval) {
        const skipped = recordSkip(
          automation,
          "Unattended run granted but no resolveApproval seam.",
          nowMs,
        );
        return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? "unattended missing seam" };
      }
      await deps.resolveApproval({
        threadKey,
        approvalId: queued.approvalId,
        approved: true,
        decidedBy: `automation:${automation.id}`,
      });
    }
    return {
      fired: true,
      automation: next,
      reason: auth.reason,
      approvalId: queued.approvalId,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const skipped = recordSkip(automation, `Queue failed: ${detail}`, nowMs);
    return { fired: false, automation: skipped, reason: skipped.lastSkip?.reason ?? detail };
  }
}

export async function fireMatchingAutomations(
  automations: Automation[],
  event: AutomationMatchEvent,
  deps: FireAutomationDeps,
): Promise<{ results: FireAutomationResult[]; automations: Automation[] }> {
  const next = new Map(automations.map((item) => [item.id, item]));
  const results: FireAutomationResult[] = [];
  for (const automation of automations) {
    const result = await fireAutomation(automation, event, deps);
    results.push(result);
    next.set(result.automation.id, result.automation);
  }
  return { results, automations: [...next.values()] };
}

export function envAutomationsEnabled(value: string | undefined): boolean {
  return automationsEnabled(value);
}
