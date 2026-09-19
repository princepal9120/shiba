/**
 * Complete End-to-End Shiba Dashboard.
 * Approval-gated coding tasks delegated to isolated Cloudflare Sandbox containers running OpenCode.
 */
import {
  getToolApproval,
  getToolPartState,
  useAgentChat,
} from "@cloudflare/ai-chat/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { isToolUIPart, type UIMessage } from "ai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffViewer } from "./components/DiffViewer";
import { VMInspector, type VMRun } from "./components/VMInspector";
import { RunRegistryView } from "./components/RunRegistryView";
import { AutomationsView } from "./components/AutomationsView";
import { MissionsView } from "./components/MissionsView";
import { GatesView } from "./components/GatesView";
import { ArchitectureView } from "./components/ArchitectureView";
import { OnboardingModal, detectSetupSteps } from "./components/OnboardingModal";
import { TaskForm } from "../../web/src/components/TaskForm";
import {
  extractPendingApprovals,
  formatTimeAgo,
  parseRepoName,
  toolDisplayName,
} from "./ui-helpers";

const ORCHESTRATOR_AGENT = "coding-orchestrator";

interface RetainedRun {
  runId: string;
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  status: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  diff?: string;
}

interface ToolRunPart {
  text?: string;
  delta?: string;
  message?: string;
  body?: string;
  [key: string]: unknown;
}

interface ToolRunRecord {
  runId: string;
  status: string;
  agentType?: string;
  parentToolCallId?: string;
  parts: ToolRunPart[];
  summary?: string;
  error?: string;
  diff?: string;
  [key: string]: unknown;
}

function partText(part: UIMessage["parts"][number]): string | null {
  if (typeof part !== "object" || part === null) return null;
  const typed = part as { type?: unknown; text?: unknown };
  if (typed.type === "text" && typeof typed.text === "string") {
    return typed.text;
  }
  return null;
}

function runPartText(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const typed = part as Record<string, unknown>;
  for (const key of ["text", "delta", "message", "body"]) {
    if (typeof typed[key] === "string") return typed[key] as string;
  }
  try {
    return JSON.stringify(part);
  } catch {
    return String(part);
  }
}

// Diff output for completed live runs. The orchestrator surfaces the unified
// diff on the run record when present; anything else is not diff output.
function extractCompletedDiff(run: unknown): string | null {
  if (typeof run !== "object" || run === null) return null;
  const record = run as Record<string, unknown>;
  if (record["status"] !== "completed") return null;
  const direct = record["diff"];
  if (typeof direct === "string" && direct.trim() !== "") return direct;
  const summary = record["summary"];
  if (typeof summary === "string" && summary.includes("diff --git")) {
    const start = summary.indexOf("diff --git");
    return summary.slice(start);
  }
  return null;
}

function useRetainedRuns(refreshToken: number): { runs: RetainedRun[]; error: string | null } {
  const [runs, setRuns] = useState<RetainedRun[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/runs")
      .then(async (response) => {
        if (!response.ok) throw new Error(`Runs request failed: ${response.status}`);
        const body = (await response.json()) as { runs?: RetainedRun[] };
        if (!cancelled) {
          setRuns(Array.isArray(body.runs) ? body.runs : []);
          setError(null);
        }
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return { runs, error };
}

type MainView = "tasks" | "vm" | "runs" | "automations" | "missions" | "gates" | "architecture";

const NAV_ITEMS: { id: MainView; label: string }[] = [
  { id: "tasks", label: "Tasks" },
  { id: "vm", label: "VM" },
  { id: "runs", label: "Runs" },
  { id: "automations", label: "Automations" },
  { id: "missions", label: "Missions" },
  { id: "gates", label: "Gates" },
  { id: "architecture", label: "Architecture" },
];

const SETUP_TOTAL_STEPS = 6;

const STARTER_TEMPLATES = [
  {
    icon: "🧪",
    label: "Fix Failing Tests",
    task: "Investigate test failures in the repository, fix the root cause, and verify all test suites pass with zero regressions.",
  },
  {
    icon: "⚡",
    label: "Add Unit Tests",
    task: "Identify uncovered functions in the core modules and add thorough unit test coverage with edge case tests.",
  },
  {
    icon: "🧹",
    label: "Refactor & Clean",
    task: "Refactor duplicate utility logic, remove unused imports and dead code, and ensure clean types across the codebase.",
  },
  {
    icon: "📖",
    label: "Documentation",
    task: "Review and update README and code comments to match recent API changes and architecture decisions.",
  },
];

export function App(): React.JSX.Element {
  const [repoUrl, setRepoUrl] = useState("");
  const [baseBranch, setBaseBranch] = useState("main");
  const [task, setTask] = useState("");
  const [publishPullRequest, setPublishPullRequest] = useState(false);
  const [harness, setHarness] = useState("opencode");
  const [refreshToken, setRefreshToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [activeTab, setActiveTab] = useState<"all" | "active" | "completed">("all");
  const [mainView, setMainView] = useState<MainView>("tasks");
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  // Header setup pill: count deployment-proven steps; refreshes when the
  // onboarding modal closes so fixes show up immediately.
  useEffect(() => {
    if (showOnboardingModal) return;
    let cancelled = false;
    detectSetupSteps()
      .then((found) => { if (!cancelled) setSetupDone(found.size); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showOnboardingModal]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const tabParam = params.get("tab") || params.get("view");
      const runParam = params.get("run");
      if (runParam) {
        setSelectedRunId(runParam);
        setMainView("vm");
      } else if (tabParam === "vm" || tabParam === "vm-inspector") {
        setMainView("vm");
      } else if (tabParam === "runs" || tabParam === "run-registry") {
        setMainView("runs");
      } else if (tabParam === "automations") {
        setMainView("automations");
      } else if (tabParam === "missions") {
        setMainView("missions");
      } else if (tabParam === "gates" || tabParam === "quality-gates") {
        setMainView("gates");
      } else if (tabParam === "architecture") {
        setMainView("architecture");
      }
    }
  }, []);

  const submitFailed = useRef(false);
  const submitInFlight = useRef(false);
  const clearInFlight = useRef(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [approvalAnnouncement, setApprovalAnnouncement] = useState("");

  // /api/runs routes by Access identity; the chat socket must use the same
  // DO name or the dashboard would read one identity's runs and chat to another.
  const [orchestratorName, setOrchestratorName] = useState<string | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/whoami")
      .then(async (res) => {
        if (!res.ok) throw new Error(`GET /api/whoami failed with ${res.status}`);
        return (await res.json()) as { agent?: string };
      })
      .then((body) => {
        if (!cancelled && typeof body.agent === "string" && body.agent !== "") {
          setOrchestratorName(body.agent);
        } else {
          setIdentityError("The server did not return an agent identity.");
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setIdentityError(error instanceof Error ? error.message : "Identity lookup failed.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT,
    // Undefined until identity resolves; never fall back to a shared name.
    name: orchestratorName ?? undefined,
  });
  const chat = useAgentChat({
    agent,
    onError: () => {
      submitFailed.current = true;
    },
  });
  const { runsById } = useAgentToolEvents({ agent });
  const { runs: retainedRuns, error: runsError } = useRetainedRuns(refreshToken);

  const toolRuns = useMemo(() => Object.values(runsById) as ToolRunRecord[], [runsById]);

  const pendingApprovals = useMemo(
    () => extractPendingApprovals(chat.messages),
    [chat.messages],
  );

  const decidedRef = useRef<Set<string>>(new Set());

  const refreshRuns = useCallback(() => setRefreshToken((token) => token + 1), []);

  // Drop decision bookkeeping for approvals that no longer wait on us.
  useEffect(() => {
    const waiting = new Set(pendingApprovals.map((approval) => approval.approvalId));
    for (const id of Array.from(decidedRef.current)) {
      if (!waiting.has(id)) decidedRef.current.delete(id);
    }
    setDecisions((current) => {
      const next: Record<string, boolean> = {};
      let changed = false;
      for (const [id, approved] of Object.entries(current)) {
        if (waiting.has(id)) {
          next[id] = approved;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [pendingApprovals]);

  // One synchronous guard per approvalId: duplicate clicks are inert, and the
  // guard clears when the part leaves "waiting-approval".
  const decideApproval = useCallback(
    async (approvalId: string, approved: boolean) => {
      if (decidedRef.current.has(approvalId)) return;
      decidedRef.current.add(approvalId);
      setDecisions((current) => ({ ...current, [approvalId]: approved }));
      try {
        await chat.addToolApprovalResponse({ id: approvalId, approved });
        setApprovalAnnouncement(
          `Task ${approved ? "approved" : "rejected"}. ${
            approved ? "Sandbox execution is now permitted." : "No sandbox will start for this tool call."
          }`,
        );
        setNotice(null);
      } catch (decisionError) {
        // Decision failed: buttons re-enable for a retry.
        decidedRef.current.delete(approvalId);
        setDecisions((current) => {
          const next = { ...current };
          delete next[approvalId];
          return next;
        });
        setNotice(
          `${approved ? "Approval" : "Rejection"} could not be recorded: ${
            decisionError instanceof Error ? decisionError.message : String(decisionError)
          }`,
        );
      }
    },
    [chat],
  );

  useEffect(() => {
    if (chat.status === "streaming" || chat.isStreaming) {
      const timer = window.setTimeout(refreshRuns, 3000);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [chat.status, chat.isStreaming, chat.messages.length, refreshRuns]);

  const submitTask = useCallback(
    async (event?: React.FormEvent) => {
      if (event) event.preventDefault();
      if (submitInFlight.current || clearInFlight.current) return;
      if (!repoUrl.trim() || !task.trim()) {
        setNotice("Enter a repository URL and a task first.");
        return;
      }
      setNotice(null);
      const branch = baseBranch.trim() || "main";
      const text = [
        `Repository: ${repoUrl.trim()}`,
        `Base branch: ${branch}`,
        `Coding agent harness: ${harness}`,
        `Open a pull request with the result: ${publishPullRequest ? "yes" : "no"}`,
        "",
        `Task: ${task.trim()}`,
      ].join("\n");
      submitInFlight.current = true;
      submitFailed.current = false;
      setSubmitting(true);
      try {
        await chat.sendMessage({ text });
        if (!submitFailed.current) {
          setTask((current) => current === task ? "" : current);
          refreshRuns();
        }
      } catch (error) {
        setNotice(`Task could not be sent: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        submitInFlight.current = false;
        setSubmitting(false);
      }
    },
    [repoUrl, baseBranch, task, publishPullRequest, harness, chat, refreshRuns],
  );

  const confirmClearAll = useCallback(async () => {
    setShowClearModal(false);
    if (clearInFlight.current || submitInFlight.current) return;
    clearInFlight.current = true;
    setClearing(true);
    setNotice(null);
    let historyCleared = false;
    try {
      await chat.clearHistory();
      historyCleared = true;
      const response = await fetch("/api/runs", { method: "DELETE" });
      if (!response.ok) throw new Error(`Runs clear failed: ${response.status}`);
      setNotice("Conversation history and run registry cleared.");
      refreshRuns();
    } catch (error) {
      setNotice(historyCleared
        ? "History cleared locally; run registry could not be cleared"
        : `History could not be cleared: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearInFlight.current = false;
      setClearing(false);
    }
  }, [chat, refreshRuns]);

  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        setNotice(`Cancellation requested for ${runId}.`);
        refreshRuns();
      } catch (error) {
        setNotice(`Cancellation could not be requested: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [refreshRuns],
  );

  // Keyboard shortcut listener: Cmd/Ctrl+Enter submits, Escape closes modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!submitting && repoUrl.trim() && task.trim()) {
          e.preventDefault();
          submitTask();
        }
      } else if (e.key === "Escape") {
        setShowClearModal(false);
        setShowShortcutsModal(false);
        setShowOnboardingModal(false);
      } else if (e.key === "?" && !["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) {
        setShowShortcutsModal((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [submitting, repoUrl, task, submitTask]);

  const allRuns: VMRun[] = useMemo(() => {
    const map = new Map<string, VMRun>();
    for (const r of retainedRuns) {
      map.set(r.runId, {
        runId: r.runId,
        sandboxId: r.sandboxId,
        repoUrl: r.repoUrl,
        task: r.task,
        baseBranch: r.baseBranch,
        publishPullRequest: r.publishPullRequest,
        status: r.status,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        summary: r.summary,
        error: r.error,
        diff: r.diff,
      });
    }
    for (const tr of toolRuns) {
      const existing = map.get(tr.runId);
      const completedDiff = extractCompletedDiff(tr);
      if (existing) {
        existing.status = tr.status || existing.status;
        if (completedDiff) existing.diff = completedDiff;
        if (tr.summary) existing.summary = tr.summary;
        if (tr.error) existing.error = tr.error;
      } else {
        map.set(tr.runId, {
          runId: tr.runId,
          sandboxId: tr.runId,
          repoUrl: repoUrl || "https://github.com/repository",
          task: task || "Coding task in sandbox",
          baseBranch: baseBranch || "main",
          publishPullRequest: false,
          status: tr.status || "running",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          summary: tr.summary,
          error: tr.error,
          diff: completedDiff || undefined,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [retainedRuns, toolRuns, repoUrl, task, baseBranch]);

  const activeSandboxCount = useMemo(() => {
    return toolRuns.filter((r) => r.status === "running" || r.status === "pending").length +
      retainedRuns.filter((r) => r.status === "running" || r.status === "pending").length;
  }, [toolRuns, retainedRuns]);

  const connectionState = identityError
    ? `Identity error: ${identityError}`
    : agent.connectionError
    ? `Connection error: ${agent.connectionError.message ?? "unknown"}`
    : agent.identified
      ? "Connected"
      : "Connecting";

  const busy = submitting || clearing || chat.isStreaming || chat.status === "streaming" || chat.status === "submitted";

  const statusColors: Record<string, string> = {
    completed: "text-[#4cc38a] border-[#4cc38a]/30 bg-[#4cc38a]/10",
    running: "text-[#4f9cf0] border-[#4f9cf0]/30 bg-[#4f9cf0]/10",
    pending: "text-[#c9a227] border-[#c9a227]/30 bg-[#c9a227]/10",
    error: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
    aborted: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
    cancelled: "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10",
  };

  return (
    <div className="min-h-screen bg-black text-[#e6edf3] font-sans selection:bg-[#63c8c1] selection:text-black flex flex-col">
      {/* TOP HEADER BAR */}
      <header className="h-14 border-b border-white/[0.08] bg-[#07090e]/95 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between z-20 shrink-0 sticky top-0 shadow-[0_1px_3px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-3">
          <a href="/" className="flex items-center gap-2.5 text-white hover:opacity-90 transition-opacity">
            <img src="/assets/mascot/pet-logo.png" alt="Shiba Mascot" className="w-8 h-8 rounded-full bg-white shadow-[0_0_12px_rgba(11,159,149,0.4)] object-contain border border-teal-500/50" />
            <div>
              <div className="font-bold tracking-tight text-sm text-white flex items-center gap-1.5">
                Shiba
                <span className="text-[10px] font-mono text-teal-400 bg-teal-950/60 border border-teal-800/60 px-1.5 py-0.2 rounded">
                  Cloudflare Native
                </span>
              </div>
            </div>
          </a>
        </div>

        {/* DESKTOP VIEW NAVIGATION TABS */}
        <nav className="hidden md:flex items-center gap-1 bg-[#0d1117] p-1 rounded-xl border border-white/[0.08] text-xs shadow-inner">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setMainView(item.id)}
              className={`px-3 py-1.5 rounded-lg transition-colors flex items-center gap-1.5 ${
                mainView === item.id
                  ? "bg-teal-950/80 text-teal-300 border border-teal-500/30 font-semibold shadow-sm"
                  : "text-[#8b98a9] hover:text-white hover:bg-white/[0.04]"
              }`}
            >
              <span>{item.label}</span>
              {item.id === "vm" && activeSandboxCount > 0 ? (
                <span className="w-2 h-2 rounded-full bg-teal-400 animate-pulse" />
              ) : null}
            </button>
          ))}
        </nav>

        <div className="flex items-center gap-3 sm:gap-4">
          {/* Active Sandboxes Pill */}
          <div className="hidden sm:inline-flex items-center gap-1.5 border border-white/[0.08] bg-[#0d1117] rounded-full px-2.5 py-1 text-xs font-mono text-[#8b98a9] shadow-sm">
            <span className={`w-1.5 h-1.5 rounded-full ${activeSandboxCount > 0 ? "bg-[#4f9cf0] animate-pulse" : "bg-zinc-600"}`} />
            <span>{activeSandboxCount} / 5 sandboxes active</span>
          </div>

          {/* Connection Status */}
          <div
            className="inline-flex items-center gap-2 border border-white/[0.08] bg-[#0d1117] rounded-full px-3 py-1 text-xs font-medium text-[#8b98a9] shadow-sm"
            role="status"
            aria-live="polite"
          >
            <span
              className={`w-2 h-2 rounded-full ${
                agent.connectionError
                  ? "bg-[#f06666]"
                  : agent.identified
                  ? "bg-[#4cc38a] shadow-[0_0_8px_rgba(76,195,138,0.5)]"
                  : "bg-[#c9a227] animate-pulse"
              }`}
              aria-hidden="true"
            />
            <span className="truncate max-w-[140px] sm:max-w-none">{connectionState}</span>
          </div>

          {/* Shortcuts & Help */}
          <button
            type="button"
            onClick={() => setShowShortcutsModal(true)}
            className="w-8 h-8 rounded-lg border border-white/[0.08] bg-[#0d1117] hover:bg-[#1f2937] text-[#8b98a9] hover:text-white flex items-center justify-center text-xs font-mono transition-colors shadow-sm"
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
          >
            ?
          </button>

          {/* Onboarding Setup Guide — pill shows live progress when incomplete */}
          <button
            type="button"
            onClick={() => setShowOnboardingModal(true)}
            className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-md transition-colors border ${
              setupDone !== null && setupDone < SETUP_TOTAL_STEPS
                ? "text-[#c9a227] hover:text-[#e9d890] border-[#c9a227]/40 hover:border-[#c9a227]/70 bg-[#c9a227]/10"
                : "text-teal-300 hover:text-teal-200 border-teal-500/40 hover:border-teal-400/80 bg-teal-950/50 hover:bg-teal-900/60 shadow-[0_0_8px_rgba(11,159,149,0.2)]"
            }`}
            title="Setup & Onboarding Guide"
            aria-label="Setup & Onboarding Guide"
          >
            <span className="hidden sm:inline">
              {setupDone !== null && setupDone < SETUP_TOTAL_STEPS
                ? `Setup ${setupDone}/${SETUP_TOTAL_STEPS}`
                : "Setup Guide"}
            </span>
            <span className="sm:hidden">Setup</span>
          </button>

          {/* Links */}
          <a
            href="/docs/"
            className="text-xs text-[#4f9cf0] hover:text-[#3b82f6] font-medium transition-colors border border-neutral-800 px-2.5 py-1 rounded-md bg-black"
          >
            Docs
          </a>
        </div>
      </header>

      {/* MOBILE VIEW NAVIGATION TABS */}
      <div className="md:hidden flex items-center justify-between px-3 py-2 bg-[#090b0e] border-b border-neutral-800 overflow-x-auto text-xs font-mono shrink-0 gap-1">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setMainView(item.id)}
            className={`px-2.5 py-1 rounded whitespace-nowrap flex items-center gap-1.5 ${mainView === item.id ? "bg-teal-950 text-teal-300 font-bold border border-teal-800/60" : "text-[#8b98a9]"}`}
          >
            <span>{item.label}</span>
            {item.id === "vm" && activeSandboxCount > 0 ? (
              <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
            ) : null}
          </button>
        ))}
      </div>

      {mainView === "tasks" ? (
      <div className="flex-1 flex flex-col xl:flex-row overflow-hidden">
        {/* SIDEBAR: Config & Task Form */}
        <aside className="w-full xl:w-96 border-r-0 xl:border-r border-neutral-800 bg-[#090b0e] flex flex-col shrink-0 h-auto xl:h-[calc(100vh-3.5rem)] overflow-y-auto">
          <div className="p-5 xl:p-6 border-b border-neutral-800">
            <div className="flex items-center justify-between mb-2">
              <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
                <img src="/assets/mascot/pet-logo.png" alt="Mascot" className="w-6 h-6 rounded-full bg-white object-contain border border-teal-500/40" />
                New Coding Task
              </h1>
              <span className="text-[11px] font-mono text-[#8b98a9]">v0.1.0</span>
            </div>
            <p className="text-xs text-[#8b98a9] leading-relaxed mb-3">
              Self-hosted on your Cloudflare account. Shiba plans tasks, delegates to isolated Sandbox micro-containers, and awaits your approval.
            </p>

            {/* Quick Starter Templates */}
            <div className="mt-3">
              <div className="text-[10px] font-semibold text-[#8b98a9] uppercase tracking-wider mb-2 flex items-center justify-between">
                <span>Quick Starters</span>
                <span className="font-mono text-[9px] text-teal-400">Click to load</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {STARTER_TEMPLATES.map((tmpl) => (
                  <button
                    key={tmpl.label}
                    type="button"
                    onClick={() => {
                      setTask(tmpl.task);
                      if (!repoUrl) setRepoUrl("https://github.com/cloudflare/ai-chat");
                    }}
                    className="text-left text-[11px] p-2 rounded-lg bg-[#0d1117] hover:bg-[#161d27] text-[#e6edf3] border border-white/[0.06] hover:border-teal-500/40 transition-all flex items-center gap-1.5 group shadow-sm"
                  >
                    <span className="text-xs shrink-0">{tmpl.icon}</span>
                    <span className="truncate group-hover:text-teal-300 transition-colors font-medium">{tmpl.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="p-5 xl:p-6 flex-1 flex flex-col gap-4">
            <h2 className="text-xs font-bold uppercase tracking-wider text-[#8b98a9]">Configuration</h2>

            <TaskForm
              repoUrl={repoUrl}
              task={task}
              baseBranch={baseBranch}
              publishPullRequest={publishPullRequest}
              harness={harness}
              busy={busy}
              submitting={submitting}
              clearing={clearing}
              onRepoUrlChange={setRepoUrl}
              onTaskChange={setTask}
              onBaseBranchChange={setBaseBranch}
              onPublishPullRequestChange={setPublishPullRequest}
              onHarnessChange={setHarness}
              onSubmit={submitTask}
              onClear={() => setShowClearModal(true)}
            />

            <div className="text-[11px] text-[#8b98a9] text-center pt-1 font-mono">
              Tip: Press <kbd className="bg-black px-1 py-0.5 rounded border border-neutral-800">⌘</kbd> + <kbd className="bg-black px-1 py-0.5 rounded border border-neutral-800">Enter</kbd> to submit
            </div>

            {notice ? (
              <div className="text-xs text-[#8b98a9] bg-black p-3 rounded-lg border border-neutral-800 flex items-start gap-2">
                <svg className="w-4 h-4 text-[#4f9cf0] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="break-words">{notice}</div>
              </div>
            ) : null}

            {chat.error ? (
              <div className="text-xs text-[#f06666] bg-[#f06666]/10 p-3 rounded-lg border border-[#f06666]/30 flex items-start gap-2">
                <svg className="w-4 h-4 text-[#f06666] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <div className="break-words">Chat error: {chat.error.message}</div>
              </div>
            ) : null}

            {runsError ? (
              <div className="text-xs text-[#f06666] bg-[#f06666]/10 p-3 rounded-lg border border-[#f06666]/30 flex items-start gap-2">
                <svg className="w-4 h-4 text-[#f06666] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="break-words">Runs registry: {runsError}</div>
              </div>
            ) : null}

            {/* Architecture Info Pill */}
            <div className="mt-auto pt-4 border-t border-neutral-800 flex flex-col gap-1.5 text-[11px] text-[#8b98a9] font-mono">
              <div className="flex items-center justify-between">
                <span>Orchestrator:</span>
                <span className="text-[#e6edf3]">Think (Llama 3.1)</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Coding Engine:</span>
                <span className="text-[#e6edf3]">OpenCode (Gemini)</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Isolation:</span>
                <span className="text-[#4cc38a]">Cloudflare Sandbox</span>
              </div>
            </div>
          </div>
        </aside>

        {/* MAIN CONTENT: Conversation & Runs */}
        <main className="flex-1 flex flex-col h-auto xl:h-[calc(100vh-3.5rem)] overflow-hidden bg-black">
          {/* TOP METRICS SUMMARY RIBBON */}
          <div className="border-b border-white/[0.08] bg-[#07090e]/60 px-6 py-2.5 flex items-center justify-between flex-wrap gap-3 text-xs shrink-0">
            <div className="flex items-center gap-4 text-xs font-mono text-[#8b98a9]">
              <div className="flex items-center gap-1.5">
                <span className="text-neutral-500">Active Tasks:</span>
                <span className="text-teal-400 font-bold">{toolRuns.length}</span>
              </div>
              <div className="w-px h-3.5 bg-white/[0.1]" />
              <div className="flex items-center gap-1.5">
                <span className="text-neutral-500">Pending Approvals:</span>
                <span className={pendingApprovals.length > 0 ? "font-bold text-[#f59e0b]" : "font-bold text-neutral-400"}>
                  {pendingApprovals.length}
                </span>
              </div>
              <div className="w-px h-3.5 bg-white/[0.1] hidden sm:block" />
              <div className="hidden sm:flex items-center gap-1.5">
                <span className="text-neutral-500">Total Runs:</span>
                <span className="text-white font-bold">{allRuns.length}</span>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wider font-mono text-teal-400/80 bg-teal-950/60 border border-teal-800/40 px-2 py-0.5 rounded">
                Zero-Trust Boundary
              </span>
            </div>
          </div>

          {/* TOP: PENDING APPROVALS ALERT */}
          {(pendingApprovals.length > 0 || approvalAnnouncement) ? (
            <div className="bg-[#090b0e] border-b border-neutral-800 px-6 xl:px-8 py-3.5 flex items-center justify-between shadow-sm z-10 shrink-0">
              <p className="text-sm font-medium text-[#e6edf3]" role="status" aria-live="polite">
                {pendingApprovals.length > 0 ? (
                  <span className="flex items-center gap-2 text-[#c9a227]">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#c9a227] animate-pulse shadow-[0_0_8px_rgba(201,162,39,0.6)]" />
                    {pendingApprovals.length} task{pendingApprovals.length === 1 ? "" : "s"} waiting for your approval.
                  </span>
                ) : (
                  <span className="text-[#4cc38a] flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {approvalAnnouncement}
                  </span>
                )}
              </p>
            </div>
          ) : null}

          <div className="flex-1 overflow-y-auto p-5 xl:p-8 flex flex-col xl:flex-row gap-6 xl:gap-8">
            {/* CONVERSATION AREA */}
            <section className="flex-1 min-w-0 flex flex-col gap-5" aria-label="Conversation">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                <div className="flex items-center gap-2.5">
                  <h2 className="text-base font-semibold text-white">Conversation</h2>
                  {chat.messages.length > 0 ? (
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-[#090b0e] border border-neutral-800 text-[#8b98a9]">
                      {chat.messages.length} message{chat.messages.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </div>
              </div>

              {chat.messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 border border-dashed border-neutral-800 rounded-xl bg-[#090b0e]/40 px-6 text-center">
                  <img src="/assets/mascot/shiba-sticker-hero.webp" alt="Shiba illustration mascot" className="w-56 h-auto max-h-40 rounded-xl shadow-lg border border-teal-500/30 mb-3 object-cover transition-transform hover:scale-105" />
                  <p className="text-[#8b98a9] text-sm mb-2 font-medium">No messages yet. Submit a task to start.</p>
                  <p className="text-xs text-[#8b98a9]/70 max-w-sm">
                    Shiba is ready. Enter a repository and describe the changes you want.
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowOnboardingModal(true)}
                    className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-teal-300 hover:text-teal-200 border border-teal-500/40 bg-teal-950/60 hover:bg-teal-900/70 px-3.5 py-1.5 rounded-lg transition-colors shadow-[0_0_8px_rgba(11,159,149,0.3)]"
                  >
                    <span>View Setup Checklist & Architecture</span>
                  </button>
                </div>
              ) : (
                <ol className="flex flex-col gap-5">
                  {chat.messages.map((message) => (
                    <li key={message.id} className={`flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
                      <div className="flex items-center gap-1.5 text-xs font-semibold text-[#8b98a9] uppercase tracking-wider mb-1 px-1">
                        {message.role === "user" ? (
                          <>
                            <span>You</span>
                            <span className="w-1.5 h-1.5 rounded-full bg-[#4f9cf0]" />
                          </>
                        ) : (
                          <div className="flex items-center gap-1.5">
                            <img src="/assets/mascot/pet-logo.png" alt="Shiba" className="w-4 h-4 rounded-full bg-white object-contain border border-teal-500/40 shadow-sm" />
                            <span className="text-teal-400 font-bold">Shiba</span>
                          </div>
                        )}
                      </div>
                      <div
                        className={`flex flex-col gap-2 max-w-[92%] md:max-w-[85%] ${
                          message.role === "user"
                            ? "bg-[#4f9cf0] text-[#06121f] rounded-2xl rounded-tr-sm p-4 font-medium shadow-sm"
                            : "bg-[#090b0e] border border-neutral-800 text-[#e6edf3] rounded-2xl rounded-tl-sm p-4 shadow-sm"
                        }`}
                      >
                        {message.parts.map((part, index) => {
                          const text = partText(part);
                          if (text !== null) {
                            return (
                              <pre key={index} className="whitespace-pre-wrap font-sans text-sm break-words leading-relaxed">
                                {text}
                              </pre>
                            );
                          }
                          if (isToolUIPart(part)) {
                            const state = getToolPartState(part);
                            const approval = getToolApproval(part);
                            return (
                              <div
                                key={index}
                                className="flex flex-wrap items-center gap-2 mt-2 bg-black/70 p-2.5 rounded-lg border border-neutral-800/60 font-mono text-xs"
                              >
                                <span className="text-teal-400 font-semibold bg-[#2a3441]/60 px-2 py-0.5 rounded">
                                  {toolDisplayName(part)}
                                </span>
                                <span
                                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                                    approval?.approved === false
                                      ? "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10"
                                      : state === "waiting-approval"
                                      ? "text-[#c9a227] border-[#c9a227]/30 bg-[#c9a227]/10 animate-pulse"
                                      : "text-[#8b98a9] border-neutral-800 bg-[#090b0e]"
                                  }`}
                                >
                                  {approval?.approved === false ? "Rejected" : state}
                                </span>
                              </div>
                            );
                          }
                          return null;
                        })}
                      </div>
                    </li>
                  ))}

                  {/* Streaming indicator */}
                  {(chat.isStreaming || chat.status === "streaming") ? (
                    <li className="flex flex-col items-start">
                      <div className="flex items-center gap-2 text-xs font-semibold text-teal-400 mb-1 px-1">
                        <img src="/assets/mascot/pet-logo.png" alt="Shiba" className="w-4 h-4 rounded-full bg-white object-contain border border-teal-500/40 shadow-sm animate-bounce" />
                        Shiba is reasoning...
                      </div>
                      <div className="bg-[#090b0e] border border-neutral-800 rounded-2xl rounded-tl-sm p-4 text-xs text-[#8b98a9] flex items-center gap-2">
                        <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-teal-400 border-t-transparent rounded-full" />
                        <span>Planning coding execution in sandbox</span>
                      </div>
                    </li>
                  ) : null}
                </ol>
              )}

              {/* PENDING APPROVALS CARDS */}
              {pendingApprovals.length > 0 ? (
                <div className="mt-4 border-t border-neutral-800 pt-5 flex flex-col gap-4" role="group" aria-label="Pending approvals">
                  <div className="flex items-center justify-between">
                    <h3 className="text-xs font-bold uppercase tracking-wider text-[#c9a227] flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#c9a227] animate-pulse" />
                      Waiting for your approval
                    </h3>
                    <span className="text-[11px] text-[#8b98a9] font-mono">Approval Gate 1</span>
                  </div>

                  {pendingApprovals.map((approval) => (
                    <div
                      key={approval.approvalId}
                      className="border border-[#c9a227]/60 bg-[#090b0e] rounded-xl p-5 shadow-lg shadow-[#c9a227]/5 flex flex-col gap-3"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-mono font-bold text-sm text-[#e6edf3] flex items-center gap-2">
                          <img src="/assets/mascot/pet-logo.png" alt="Shiba Guard" className="w-5 h-5 rounded-full bg-white object-contain border border-amber-500/50" />
                          {approval.tool}
                        </div>
                        <span className="text-[10px] uppercase tracking-wider font-bold bg-[#c9a227]/15 border border-[#c9a227]/30 text-[#c9a227] px-2 py-0.5 rounded-full">
                          Action Required
                        </span>
                      </div>

                      <pre className="whitespace-pre-wrap font-mono text-xs text-[#8b98a9] bg-black p-3 rounded-lg border border-neutral-800 max-h-56 overflow-auto mb-1">
                        {typeof approval.input === "string" ? approval.input : JSON.stringify(approval.input, null, 2)}
                      </pre>

                      <p className="text-xs text-[#8b98a9] leading-relaxed">
                        Approving starts an isolated sandbox run. Rejecting stops the tool call.
                      </p>

                      <div className="flex items-center gap-3 pt-1">
                        <button
                          type="button"
                          className="bg-[#4cc38a] hover:bg-[#3ba875] text-[#06121f] font-semibold py-2 px-5 rounded-lg transition-colors disabled:opacity-50 text-sm shadow-sm flex items-center gap-1.5"
                          disabled={decisions[approval.approvalId] !== undefined}
                          onClick={() => decideApproval(approval.approvalId, true)}
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                          </svg>
                          <span>Approve</span>
                        </button>
                        <button
                          type="button"
                          className="bg-transparent border border-[#f06666] text-[#f06666] hover:bg-[#f06666]/10 font-semibold py-2 px-5 rounded-lg transition-colors disabled:opacity-50 text-sm flex items-center gap-1.5"
                          disabled={decisions[approval.approvalId] !== undefined}
                          onClick={() => decideApproval(approval.approvalId, false)}
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          <span>Reject</span>
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>

            {/* RUNS AREA */}
            <section className="flex-1 min-w-0 flex flex-col gap-5" aria-label="Delegated runs">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                <div className="flex items-center gap-3">
                  <h2 className="text-base font-semibold text-white">Delegated Runs</h2>
                  {/* Status filter tabs */}
                  <div className="hidden sm:flex items-center gap-1 bg-black p-0.5 rounded-lg border border-neutral-800 text-xs">
                    <button
                      type="button"
                      onClick={() => setActiveTab("all")}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        activeTab === "all" ? "bg-[#2a3441] text-white font-medium" : "text-[#8b98a9] hover:text-white"
                      }`}
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("active")}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        activeTab === "active" ? "bg-[#2a3441] text-white font-medium" : "text-[#8b98a9] hover:text-white"
                      }`}
                    >
                      Active
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveTab("completed")}
                      className={`px-2.5 py-1 rounded-md transition-colors ${
                        activeTab === "completed" ? "bg-[#2a3441] text-white font-medium" : "text-[#8b98a9] hover:text-white"
                      }`}
                    >
                      Completed
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  className="text-xs bg-[#090b0e] hover:bg-[#2a3441] border border-neutral-800 text-[#e6edf3] font-medium py-1.5 px-3 rounded-md transition-colors flex items-center gap-1.5"
                  onClick={refreshRuns}
                  title="Refresh runs"
                >
                  <svg className="w-3.5 h-3.5 text-[#8b98a9]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Refresh</span>
                </button>
              </div>

              {/* LIVE RUNS LIST */}
              {toolRuns.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 border border-dashed border-neutral-800 rounded-xl bg-[#090b0e]/40 px-4 text-center">
                  <p className="text-[#8b98a9] text-sm">No live runs. Approved tasks appear here while they execute.</p>
                </div>
              ) : (
                <ol className="flex flex-col gap-4">
                  {toolRuns
                    .filter((run) => {
                      if (activeTab === "active") return run.status === "running" || run.status === "pending";
                      if (activeTab === "completed") return run.status === "completed";
                      return true;
                    })
                    .map((run) => {
                      const completedDiff = extractCompletedDiff(run);
                      const sColor = statusColors[run.status] || "text-[#8b98a9] border-neutral-800 bg-[#090b0e]";

                      return (
                        <li key={run.runId} className="border border-white/[0.08] rounded-xl p-4 bg-[#07090e] shadow-md">
                          <div className="flex items-start justify-between gap-3 mb-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="w-2 h-2 rounded-full bg-teal-400" />
                              <span className="font-mono text-xs text-[#e6edf3] break-all">{run.runId}</span>
                            </div>
                            <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ${sColor}`}>
                              {run.status}
                            </span>
                          </div>

                          <div className="text-xs text-[#8b98a9] mb-3 font-mono flex flex-wrap gap-x-2">
                            <span>{run.agentType}</span>
                            {run.parentToolCallId ? <span>· tool call {run.parentToolCallId}</span> : null}
                          </div>

                          {/* Terminal Output Parts */}
                          {run.parts.length > 0 ? (
                            <pre className="font-mono text-xs text-[#8b98a9] bg-black p-3 rounded-lg border border-neutral-800 max-h-40 overflow-auto whitespace-pre-wrap break-words mb-3">
                              {run.parts.map(runPartText).join("\n")}
                            </pre>
                          ) : null}

                          {run.summary ? (
                            <pre className="font-mono text-xs text-[#e6edf3] bg-black p-3 rounded-lg border border-neutral-800 max-h-40 overflow-auto whitespace-pre-wrap break-words mb-3">
                              {run.summary}
                            </pre>
                          ) : null}

                          {run.error ? (
                            <p className="text-xs text-[#f06666] bg-[#f06666]/10 p-3 rounded-lg border border-[#f06666]/20 mb-3">
                              {run.error}
                            </p>
                          ) : null}

                          <div className="flex items-center gap-2 mb-3">
                              <button
                                type="button"
                                className="text-xs bg-teal-950/60 hover:bg-teal-900 border border-teal-800/60 text-teal-300 font-medium py-1.5 px-3 rounded-md transition-colors flex items-center gap-1.5"
                                onClick={() => {
                                  setSelectedRunId(run.runId);
                                  setMainView("vm");
                                }}
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                                <span>Inspect VM</span>
                              </button>
                            </div>
                            {run.status === "completed" && completedDiff ? (
                            <div className="mt-3">
                              <DiffViewer diff={completedDiff} runId={run.runId} />
                            </div>
                          ) : null}

                          {run.status === "completed" && !completedDiff ? (
                            <p className="text-xs text-[#8b98a9] italic">No file changes produced</p>
                          ) : null}
                        </li>
                      );
                    })}
                </ol>
              )}

              {/* RETAINED RUNS SECTION */}
              <h3 className="text-xs font-bold uppercase tracking-wider text-[#8b98a9] mt-4 border-t border-neutral-800 pt-6 flex items-center justify-between">
                <span>Retained Runs</span>
                {retainedRuns.length > 0 ? (
                  <span className="text-[11px] font-mono lowercase">{retainedRuns.length} total</span>
                ) : null}
              </h3>

              {retainedRuns.length === 0 ? (
                <p className="text-[#8b98a9] text-sm">No retained runs on the orchestrator yet.</p>
              ) : (
                <ol className="flex flex-col gap-3">
                  {retainedRuns
                    .filter((run) => {
                      if (activeTab === "active") return run.status === "running" || run.status === "pending";
                      if (activeTab === "completed") return run.status === "completed";
                      return true;
                    })
                    .map((run) => {
                      const sColor = statusColors[run.status] || "text-[#8b98a9] border-neutral-800 bg-[#090b0e]";
                      const repoName = parseRepoName(run.repoUrl);

                      return (
                        <li key={run.runId} className="border border-white/[0.08] rounded-xl bg-[#07090e] overflow-hidden shadow-sm hover:border-white/[0.15] transition-colors">
                          <details className="group">
                            <summary
                              className="flex items-center justify-between p-4 cursor-pointer hover:bg-[#2a3441]/30 transition-colors select-none"
                              aria-label={`${run.task} — ${run.repoUrl} — ${run.status}`}
                            >
                              <div className="flex items-center gap-3 overflow-hidden">
                                <svg
                                  className="w-4 h-4 text-[#8b98a9] transform group-open:rotate-90 transition-transform shrink-0"
                                  fill="none"
                                  viewBox="0 0 24 24"
                                  stroke="currentColor"
                                >
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                </svg>
                                <span className="font-mono text-xs text-[#e6edf3] truncate font-medium">
                                  {repoName}
                                </span>
                                <span className="hidden sm:inline-block text-[11px] text-[#8b98a9] font-mono">
                                  {formatTimeAgo(run.createdAt)}
                                </span>
                              </div>
                              <span className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 ml-3 ${sColor}`}>
                                {run.status}
                              </span>
                            </summary>

                            <div className="p-4 pt-0 border-t border-neutral-800/50 mt-1 flex flex-col gap-3">
                              <div className="text-[11px] text-[#8b98a9] font-mono flex flex-wrap gap-x-3 gap-y-1">
                                <span>Sandbox: {run.sandboxId}</span>
                                <span>Branch: {run.baseBranch}</span>
                                {run.publishPullRequest ? (
                                  <span className="text-teal-400">· pull request requested</span>
                                ) : null}
                              </div>

                              <pre className="font-sans text-sm text-[#e6edf3] whitespace-pre-wrap break-words bg-black/40 p-2.5 rounded-lg border border-neutral-800/50">
                                {run.task}
                              </pre>

                              {run.summary ? (
                                <pre className="font-mono text-xs text-[#e6edf3] bg-black p-3 rounded-lg border border-neutral-800 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                                  {run.summary}
                                </pre>
                              ) : null}

                              {run.error ? (
                                <p className="text-xs text-[#f06666] bg-[#f06666]/10 p-3 rounded-lg border border-[#f06666]/20">
                                  {run.error}
                                </p>
                              ) : null}

                              {run.status === "completed" && run.diff ? (
                                <DiffViewer diff={run.diff} runId={run.runId} />
                              ) : null}

                              <div className="flex items-center gap-2 pt-1">
                                {(run.status === "pending" || run.status === "running") ? (
                                  <button
                                    type="button"
                                    className="text-xs bg-transparent border border-[#f06666] hover:bg-[#f06666]/10 text-[#f06666] font-medium py-1.5 px-3 rounded-md transition-colors"
                                    onClick={() => cancelRun(run.runId)}
                                  >
                                    Cancel run
                                  </button>
                                ) : null}

                                <button
                                  type="button"
                                  className="text-xs bg-teal-950/60 hover:bg-teal-900 border border-teal-800/60 text-teal-300 font-medium py-1.5 px-3 rounded-md transition-colors flex items-center gap-1.5"
                                  onClick={() => {
                                    setSelectedRunId(run.runId);
                                    setMainView("vm");
                                  }}
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                  </svg>
                                  <span>Inspect VM</span>
                                </button>
                                <button
                                  type="button"
                                  className="text-xs bg-black hover:bg-[#2a3441] border border-neutral-800 text-[#8b98a9] hover:text-[#e6edf3] font-medium py-1.5 px-3 rounded-md transition-colors"
                                  onClick={() => {
                                    setRepoUrl(run.repoUrl);
                                    setBaseBranch(run.baseBranch);
                                    setTask(run.task);
                                    setPublishPullRequest(run.publishPullRequest);
                                  }}
                                >
                                  Reuse parameters
                                </button>
                              </div>
                            </div>
                          </details>
                        </li>
                      );
                    })}
                </ol>
              )}
            </section>
          </div>
        </main>
      </div>
      ) : mainView === "vm" ? (
        <VMInspector
          runs={allRuns}
          selectedRunId={selectedRunId}
          onSelectRun={(id) => setSelectedRunId(id)}
        />
      ) : mainView === "runs" ? (
        <RunRegistryView
          runs={retainedRuns}
          onInspectVM={(id) => {
            setSelectedRunId(id);
            setMainView("vm");
          }}
          onReuseParams={(run) => {
            setRepoUrl(run.repoUrl);
            setBaseBranch(run.baseBranch);
            setTask(run.task);
            setPublishPullRequest(run.publishPullRequest);
            setMainView("tasks");
          }}
          onCancelRun={cancelRun}
          onClearHistory={() => setShowClearModal(true)}
          onRefresh={refreshRuns}
        />
      ) : mainView === "automations" ? (
        <AutomationsView />
      ) : mainView === "missions" ? (
        <MissionsView />
      ) : mainView === "gates" ? (
        <GatesView />
      ) : (
        <ArchitectureView />
      )}

      {/* CLEAR HISTORY CONFIRMATION MODAL */}
      {showClearModal ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#090b0e] border border-neutral-800 rounded-xl max-w-md w-full p-6 shadow-2xl">
            <h3 className="text-lg font-bold text-white mb-2">Clear Conversation & Runs?</h3>
            <p className="text-sm text-[#8b98a9] mb-5 leading-relaxed">
              This will erase all active conversation history and delete retained run registry records on the orchestrator. Active sandboxes will not be destroyed automatically.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                className="px-4 py-2 rounded-lg text-sm font-medium text-[#8b98a9] hover:text-white bg-black border border-neutral-800 transition-colors"
                onClick={() => setShowClearModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-[#f06666] hover:bg-[#d85555] transition-colors shadow-sm"
                onClick={confirmClearAll}
              >
                Yes, Clear History
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {/* ONBOARDING SETUP MODAL */}
      <OnboardingModal
        isOpen={showOnboardingModal}
        onClose={() => setShowOnboardingModal(false)}
        onSelectStarterTask={(repo, t, h) => {
          setRepoUrl(repo);
          setTask(t);
          setHarness(h);
        }}
      />

      {/* KEYBOARD SHORTCUTS MODAL */}
      {showShortcutsModal ? (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-[#090b0e] border border-neutral-800 rounded-xl max-w-md w-full p-6 shadow-2xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-white">Keyboard Shortcuts</h3>
              <button
                type="button"
                onClick={() => setShowShortcutsModal(false)}
                className="text-[#8b98a9] hover:text-white text-sm font-mono"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-2.5 text-xs">
              <div className="flex items-center justify-between py-1.5 border-b border-neutral-800">
                <span className="text-[#8b98a9]">Submit Task</span>
                <span className="font-mono bg-black border border-neutral-800 px-2 py-0.5 rounded text-[#e6edf3]">
                  ⌘ / Ctrl + Enter
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-neutral-800">
                <span className="text-[#8b98a9]">Close Modals</span>
                <span className="font-mono bg-black border border-neutral-800 px-2 py-0.5 rounded text-[#e6edf3]">
                  Escape
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-neutral-800">
                <span className="text-[#8b98a9]">Open Shortcuts Guide</span>
                <span className="font-mono bg-black border border-neutral-800 px-2 py-0.5 rounded text-[#e6edf3]">
                  ?
                </span>
              </div>
            </div>
            <div className="mt-5 text-right">
              <button
                type="button"
                className="px-4 py-1.5 rounded-lg text-xs font-medium text-[#e6edf3] bg-black border border-neutral-800 hover:bg-[#2a3441] transition-colors"
                onClick={() => setShowShortcutsModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}






