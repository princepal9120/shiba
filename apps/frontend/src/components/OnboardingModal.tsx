import React, { useEffect, useId, useState } from "react";

export interface OnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectStarterTask?: (repoUrl: string, task: string, harness: string) => void;
}

export interface SetupStep {
  id: string;
  title: string;
  category: string;
  required: boolean;
  summary: string;
  detail: string;
  codeSnippet?: string;
  planRef: string;
  docAnchor: string;
}

export const ONBOARDING_STEPS: SetupStep[] = [
  {
    id: "workers-paid",
    title: "Cloudflare Workers Paid & Container Sandbox",
    category: "Infrastructure",
    required: true,
    summary: "Workers Paid ($5/mo) enables Durable Objects with SQLite backend and Sandbox containers.",
    detail:
      "PLAN.md Phase P0 (T1-T2) requires SQLite storage migrations (new_sqlite_classes) for CodingOrchestrator and Sandbox. The micro-container runs standard-1 (1 vCPU, 4 GiB) with a maximum ceiling of standard-4 (4 vCPU, 12 GiB, 20 GB).",
    codeSnippet: `// wrangler.jsonc
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["CodingOrchestrator", "OpenCodeAgent", "Sandbox"] }],
"containers": [{
  "class_name": "Sandbox",
  "name": "shiba-ai-coworker-sandbox",
  "image": "./Dockerfile",
  "instance_type": "standard-1",
  "max_instances": 5
}]`,
    planRef: "PLAN.md §5 (T1, T2)",
    docAnchor: "2-infrastructure-setup-planmd-5-t1t2",
  },
  {
    id: "ai-gateway",
    title: "Cloudflare AI Gateway & Stored BYOK Keys",
    category: "AI Gateway",
    required: true,
    summary: "Store your Gemini, Anthropic, or OpenAI API keys inside Cloudflare AI Gateway BYOK.",
    detail:
      "PLAN.md §5 (T3, T4) & §11 (T23): AI Gateway acts as the secure reverse proxy. The container never holds real API keys; it runs with a dummy key, and the Worker's Sandbox egress proxy injects the stored credential.",
    codeSnippet: `# In Cloudflare Dashboard -> AI Gateway -> Your Gateway (e.g. 'default')
# Add Bring-Your-Own-Keys (BYOK):
# 1. Google AI Studio (for Gemini 3.8 Flash / 3.5 Flash Lite)
# 2. Anthropic (for Claude 3.7 / Sonnet 4.6)
# 3. OpenAI (for Codex / GPT-4o / GPT-5)`,
    planRef: "PLAN.md §5 (T3, T4) & §8",
    docAnchor: "3-ai-gateway--byok-keys-planmd-5--8",
  },
  {
    id: "access-bypass",
    title: "Cloudflare Access & Webhook Bypass Policies",
    category: "Security",
    required: true,
    summary: "Protect the dashboard with Zero Trust Access while exempting Slack & GitHub signature webhooks.",
    detail:
      "PLAN.md §6 (T7) & §9 (T12a): Protect your Worker domain with Cloudflare Access. You MUST add an Access Bypass rule for '/api/slack/*' and '/api/github/webhook' because Slack HMAC signatures and GitHub webhooks cannot pass an interactive browser login.",
    codeSnippet: `# Cloudflare Zero Trust Dashboard:
# 1. Application: Protect https://<your-worker-domain>/
# 2. Policy 1 (Allow): Allow your organization emails/groups.
# 3. Policy 2 (Bypass): Path begins with '/api/slack/' or '/api/github/webhook'.
# In .dev.vars or Wrangler vars:
REQUIRE_ACCESS=true`,
    planRef: "PLAN.md §6 (T7) & §9 (T12)",
    docAnchor: "4-cloudflare-access--mandatory-webhook-bypasses-planmd-6--9",
  },
  {
    id: "github-token",
    title: "GitHub Personal Access Token & Repo Scoping",
    category: "Integration",
    required: true,
    summary: "Configure GITHUB_TOKEN with PR write permissions. Egress proxy strictly isolates target repos.",
    detail:
      "PLAN.md §6 (T6): Store a Fine-Grained GitHub PAT or App token with 'Contents: Read & write' and 'Pull requests: Read & write'. The container egress proxy strictly scopes traffic to '/owner/repo' of the approved task, preventing arbitrary token exfiltration.",
    codeSnippet: `# Store in production Worker secrets:
npx wrangler secret put GITHUB_TOKEN
# Or for local testing in .dev.vars:
GITHUB_TOKEN=ghp_yourTokenHere`,
    planRef: "PLAN.md §6 (T6)",
    docAnchor: "5-github-token--scoped-permissions-planmd-6-t6",
  },
  {
    id: "slack-bot",
    title: "Slack Bot App & Approver Allowlist (Optional)",
    category: "Slack Bot",
    required: false,
    summary: "Enable on-call @shiba-ai-coworker mentions in Slack with Block Kit approval cards.",
    detail:
      "PLAN.md §9 (T12-T15): Create a Slack App with scopes (app_mentions:read, chat:write, channels:history). Point Events to /api/slack/events (acking <3s) and Interactivity to /api/slack/interact. Set SLACK_APPROVERS to allowlisted Slack user IDs (fails closed if empty).",
    codeSnippet: `npx wrangler secret put SLACK_BOT_TOKEN
npx wrangler secret put SLACK_SIGNING_SECRET
# Allowlist user IDs permitted to click Approve in Block Kit:
SLACK_APPROVERS=U01234567,U09876543
# Optional default repo mapping for channels:
SLACK_CHANNEL_REPOS=C04INCIDENTS:myorg/backend-api`,
    planRef: "PLAN.md §9 (T12, T15)",
    docAnchor: "6-slack-bot-integration-planmd-9-optional",
  },
  {
    id: "first-run",
    title: "First Live Run & Approval Gate (The Aha Moment)",
    category: "Verification",
    required: true,
    summary: "Submit a coding task, review the structured approval card, and watch the isolated container work.",
    detail:
      "PLAN.md §7 (T10): The core value of AI Coworker is human-in-the-loop security. When a task is submitted, Think plans it and requests approval with exact tool arguments. Once approved, the micro-container clones the repo, streams progress, tests changes, and produces a diff or PR.",
    codeSnippet: `# Example task to test:
Repository: https://github.com/cloudflare/ai-chat
Base branch: main
Coding agent harness: opencode (or claude-code / codex)
Task: Fix lint errors and verify test suite runs cleanly.`,
    planRef: "PLAN.md §7 (T10)",
    docAnchor: "7-first-acceptance-run-planmd-7-t10",
  },
];

const STORAGE_KEY = "shiba_onboarding_completed_steps";

interface SetupStatusShape {
  gateway?: { reachable?: string };
  access?: { required?: boolean };
  github?: { token?: boolean };
  slack?: { signingSecret?: boolean; botToken?: boolean; approvers?: number };
}

/**
 * Detect which onboarding steps the deployment itself proves done.
 * Shared by the modal checklist and the header setup pill.
 */
export async function detectSetupSteps(): Promise<Set<string>> {
  const found = new Set<string>(["workers-paid"]); // reachable = deployed
  const status = (await fetch("/api/setup/status")
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as SetupStatusShape | null;
  if (status) {
    if (status.gateway?.reachable === "yes") found.add("ai-gateway");
    if (status.access?.required) found.add("access-bypass");
    if (status.github?.token) found.add("github-token");
    if (status.slack?.signingSecret && status.slack?.botToken && (status.slack?.approvers ?? 0) > 0)
      found.add("slack-bot");
    const runs = (await fetch("/api/runs")
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as { runs?: unknown[] } | null;
    if ((runs?.runs?.length ?? 0) > 0) found.add("first-run");
  }
  return found;
}

export function OnboardingModal({
  isOpen,
  onClose,
  onSelectStarterTask,
}: OnboardingModalProps): React.JSX.Element | null {
  // Endowed progress: step 1 is pre-completed by default to give users a head start (+40% completion effect)
  const [completedSteps, setCompletedSteps] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        return JSON.parse(saved) as string[];
      }
    } catch {
      // ignore
    }
    return ["workers-paid"];
  });

  const [expandedStep, setExpandedStep] = useState<string | null>("workers-paid");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "pending" | "completed">("all");
  const [detected, setDetected] = useState<Set<string>>(new Set());
  const modalTitleId = useId();

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(completedSteps));
    } catch {
      // ignore
    }
  }, [completedSteps]);

  // Live-detect configured pieces from the deployment itself.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    detectSetupSteps()
      .then((found) => { if (!cancelled) setDetected(found); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  if (!isOpen) return null;

  const toggleStep = (stepId: string) => {
    setCompletedSteps((prev) =>
      prev.includes(stepId) ? prev.filter((id) => id !== stepId) : [...prev, stepId]
    );
  };

  const copySnippet = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const isStepDone = (id: string) => completedSteps.includes(id) || detected.has(id);
  const totalSteps = ONBOARDING_STEPS.length;
  const completedCount = ONBOARDING_STEPS.filter((s) => isStepDone(s.id)).length;
  const progressPercent = Math.round((completedCount / totalSteps) * 100);
  const isAllComplete = completedCount === totalSteps;
  const resetChecklist = () => {
    setCompletedSteps(["workers-paid"]);
    setExpandedStep("workers-paid");
  };

  const markAllComplete = () => {
    setCompletedSteps(ONBOARDING_STEPS.map((s) => s.id));
  };

  const filteredSteps = ONBOARDING_STEPS.filter((step) => {
    const isDone = isStepDone(step.id);
    if (filter === "pending") return !isDone;
    if (filter === "completed") return isDone;
    return true;
  });

  return (
    <div
      className="fixed inset-0 bg-black/80 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby={modalTitleId}
    >
      <div className="bg-white border border-[var(--border)] rounded-2xl max-w-2xl w-full p-5 sm:p-7 shadow-2xl my-auto text-slate-900 max-h-[90dvh] flex flex-col">
        {/* Modal Header */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-[var(--border)] shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-600/10 border border-[#0000a8]/50 flex items-center justify-center text-xl shadow-[0_0_12px_rgba(0,0,168,0.3)]">
              🚀
            </div>
            <div>
              <h2 id={modalTitleId} className="text-lg font-bold text-slate-900 flex items-center gap-2 text-balance">
                Setup & Onboarding Guide
                <span className="text-[10px] font-mono font-normal text-blue-600 bg-blue-600/10 border border-[#0000a8]/15 px-2 py-0.5 rounded-full">
                  PLAN.md End-to-End
                </span>
              </h2>
              <p className="text-xs text-slate-500 mt-0.5 text-pretty">
                Everything required to deploy, secure, and run your self-hosted AI coding engineer.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg border border-[var(--border)] bg-white hover:bg-[var(--secondary)] text-slate-500 hover:text-slate-900 flex items-center justify-center text-sm font-mono transition-colors shrink-0"
            aria-label="Close onboarding modal"
          >
            ✕
          </button>
        </div>

        {/* Progress Tracker with Endowed Progress */}
        <div className="py-3.5 border-b border-[var(--border)]/70 shrink-0">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="font-semibold text-slate-900 flex items-center gap-2">
              <span>Setup Progress</span>
              <span className="text-[11px] font-mono text-blue-600 font-normal tabular-nums">
                {completedCount} of {totalSteps} steps completed
              </span>
            </span>
            <span className="font-mono text-blue-600 font-bold tabular-nums">{progressPercent}%</span>
          </div>
          <div className="w-full bg-white rounded-full h-2 overflow-hidden border border-[var(--border)]">
            <div
              className="bg-gradient-to-r from-[#0000a8] to-[#1c1cc8] h-full rounded-full transition-all duration-300 ease-out shadow-[0_0_10px_rgba(28,28,200,0.5)]"
              style={{ width: `${progressPercent}%` }}
              role="progressbar"
              aria-valuenow={progressPercent}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>

          {/* Filter & Action Toolbar */}
          <div className="flex items-center justify-between mt-3 text-xs flex-wrap gap-2">
            <div className="inline-flex items-center p-0.5 bg-white rounded-lg border border-[var(--border)] text-[11px] font-mono">
              <button
                type="button"
                onClick={() => setFilter("all")}
                className={`px-2.5 py-0.5 rounded-md transition-colors ${filter === "all" ? "bg-[var(--line)] text-slate-900 font-semibold" : "text-slate-500 hover:text-slate-900"}`}
              >
                All ({totalSteps})
              </button>
              <button
                type="button"
                onClick={() => setFilter("pending")}
                className={`px-2.5 py-0.5 rounded-md transition-colors ${filter === "pending" ? "bg-[var(--line)] text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-900"}`}
              >
                Pending ({totalSteps - completedCount})
              </button>
              <button
                type="button"
                onClick={() => setFilter("completed")}
                className={`px-2.5 py-0.5 rounded-md transition-colors ${filter === "completed" ? "bg-[var(--line)] text-blue-600 font-semibold" : "text-slate-500 hover:text-slate-900"}`}
              >
                Completed ({completedCount})
              </button>
            </div>

            <div className="flex items-center gap-2 text-[11px] font-mono">
              {!isAllComplete ? (
                <button
                  type="button"
                  onClick={markAllComplete}
                  className="text-slate-500 hover:text-blue-600 transition-colors"
                >
                  Mark all done
                </button>
              ) : null}
              {completedCount > 1 ? (
                <button
                  type="button"
                  onClick={resetChecklist}
                  className="text-slate-500 hover:text-[#fb2c36] transition-colors"
                >
                  Reset
                </button>
              ) : null}
            </div>
          </div>
          {isAllComplete ? (
            <div className="mt-3 text-xs bg-blue-600/10 border border-[#0000a8]/40 text-blue-600 px-3 py-2 rounded-lg flex items-center justify-between">
              <span>🎉 <strong>All systems configured!</strong> You are ready to run tasks safely.</span>
              <button
                type="button"
                onClick={() => {
                  onSelectStarterTask?.(
                    "https://github.com/cloudflare/ai-chat",
                    "Add unit tests for error handling and verify the test suite passes.",
                    "opencode"
                  );
                  onClose();
                }}
                className="bg-blue-600 text-white font-semibold text-[11px] px-3 py-1 rounded hover:bg-blue-700 transition-colors shadow-sm ml-2 shrink-0"
              >
                Run First Task →
              </button>
            </div>
          ) : null}
        </div>

        {/* Step-by-Step Checklist */}
        <div className="py-3 flex flex-col gap-2.5 max-h-[55dvh] overflow-y-auto pr-1 flex-1 min-h-0">
          {filteredSteps.length === 0 ? (
            <div className="text-center py-8 text-xs text-slate-500 border border-dashed border-[var(--border)] rounded-xl">
              No steps match this filter.
            </div>
          ) : (
            filteredSteps.map((step) => {
              const idx = ONBOARDING_STEPS.findIndex((s) => s.id === step.id);
            const isDone = isStepDone(step.id);
            const isDetected = detected.has(step.id) && !completedSteps.includes(step.id);
            const isExpanded = expandedStep === step.id;

            return (
              <div
                key={step.id}
                className={`border rounded-xl transition-colors ${
                  isDone
                    ? "border-[#0000a8]/30 bg-blue-600/5"
                    : isExpanded
                    ? "border-[var(--border)] bg-white"
                    : "border-[var(--border)]/80 bg-[var(--background)] hover:border-[var(--border)]"
                }`}
              >
                <div className="p-3 sm:p-3.5 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <button
                      type="button"
                      onClick={() => toggleStep(step.id)}
                      className={`w-5 h-5 rounded-md mt-0.5 flex items-center justify-center border transition-colors shrink-0 ${
                        isDone
                          ? "bg-blue-600 border-[#0000a8] text-white font-bold text-xs shadow-[0_0_8px_rgba(28,28,200,0.6)]"
                          : "border-[var(--border)] bg-white hover:border-[#0000a8]"
                      }`}
                      role="checkbox"
                      aria-checked={isDone}
                      aria-label={`Mark ${step.title} as ${isDone ? "incomplete" : "complete"}`}
                    >
                      {isDone ? "✓" : null}
                    </button>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      aria-label={`Toggle details for step ${idx + 1}: ${step.title}`}
                      className="cursor-pointer min-w-0 text-left"
                      onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] font-mono text-slate-500">Step {idx + 1}</span>
                        <span className={`text-xs font-semibold ${isDone ? "text-blue-600 line-through opacity-80" : "text-slate-900"}`}>
                          {step.title}
                        </span>
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-white border border-[var(--border)] text-slate-500">
                          {step.category}
                        </span>
                        {!step.required ? (
                          <span className="text-[10px] text-slate-500 italic">(optional)</span>
                        ) : null}
                        {isDetected ? (
                          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-blue-600/10 border border-[#0000a8]/15 text-blue-600">
                            detected live
                          </span>
                        ) : null}
                      </div>
                      <p className="text-xs text-slate-500 mt-1 leading-relaxed line-clamp-1">
                        {step.summary}
                      </p>
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={() => setExpandedStep(isExpanded ? null : step.id)}
                    className="text-xs text-slate-500 hover:text-slate-900 font-mono px-2 py-1 rounded hover:bg-[var(--secondary)]/60 transition-colors shrink-0"
                  >
                    {isExpanded ? "▲ Hide" : "▼ Details"}
                  </button>
                </div>

                {isExpanded ? (
                  <div className="px-3 sm:px-4 pb-3.5 pt-1 border-t border-[var(--border)]/60 text-xs text-slate-500 flex flex-col gap-2.5">
                    <p className="leading-relaxed text-slate-900">{step.detail}</p>
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
                      <span>Source: <strong className="text-blue-600">{step.planRef}</strong></span>
                      <a
                        href={`/docs/onboarding/#${step.docAnchor}`}
                        className="text-blue-600 hover:underline inline-flex items-center gap-1"
                      >
                        Read Onboarding Docs →
                      </a>
                    </div>

                    {step.codeSnippet ? (
                      <div className="relative mt-1">
                        <pre className="font-mono text-[11px] text-slate-900 bg-white p-3 rounded-lg border border-[var(--border)] overflow-x-auto whitespace-pre leading-normal">
                          {step.codeSnippet}
                        </pre>
                        <button
                          type="button"
                          onClick={() => copySnippet(step.id, step.codeSnippet!)}
                          className="absolute top-2 right-2 px-2 py-1 rounded bg-white hover:bg-[var(--secondary)] border border-[var(--border)] text-[10px] font-mono text-slate-500 hover:text-slate-900 transition-colors"
                        >
                          {copiedId === step.id ? "✓ Copied" : "Copy"}
                        </button>
                      </div>
                    ) : null}

                    <div className="pt-1 flex items-center justify-between">
                      <button
                        type="button"
                        onClick={() => toggleStep(step.id)}
                        className={`text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                          isDone
                            ? "border-[var(--border)] bg-white text-slate-500 hover:text-slate-900"
                            : "border-[#0000a8]/50 bg-blue-600/10 text-blue-600 hover:bg-blue-600/15"
                        }`}
                      >
                        {isDone ? "Mark as Incomplete" : "Mark as Completed ✓"}
                      </button>

                      {step.id === "first-run" ? (
                        <button
                          type="button"
                          onClick={() => {
                            onSelectStarterTask?.(
                              "https://github.com/cloudflare/ai-chat",
                              "Verify test suite passes and add error boundary tests.",
                              "opencode"
                            );
                            onClose();
                          }}
                          className="text-xs bg-blue-600 text-white font-semibold px-3 py-1.5 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
                        >
                          Fill Starter Task & Start →
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            );
            })
          )}
        </div>

        {/* Modal Footer */}
        <div className="pt-3.5 border-t border-[var(--border)] flex items-center justify-between gap-3 shrink-0 flex-wrap">
          <a
            href="/docs/onboarding/"
            className="text-xs text-blue-600 hover:underline font-mono inline-flex items-center gap-1"
          >
            Full Architecture & Verification Guide ↗
          </a>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-1.5 rounded-lg text-xs font-medium text-slate-900 bg-white border border-[var(--border)] hover:bg-[var(--secondary)] transition-colors"
            >
              Close Guide
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

