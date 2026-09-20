/**
 * Complete End-to-End Shiba Dashboard.
 * Approval-gated coding tasks delegated to isolated Cloudflare Sandbox containers running OpenCode.
 */
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VMInspector, type VMRun } from "./components/VMInspector";
import { RunRegistryView } from "./components/RunRegistryView";
import { AutomationsView } from "./components/AutomationsView";
import { MissionsView } from "./components/MissionsView";
import { GatesView } from "./components/GatesView";
import { ArchitectureView } from "./components/ArchitectureView";
import { OnboardingModal, detectSetupSteps } from "./components/OnboardingModal";
import { SessionsSidebar, type SessionItem } from "./components/SessionsSidebar";
import { StepTimeline } from "./components/StepTimeline";
import { WorkspacePanel, type WorkspaceTab } from "./components/WorkspacePanel";
import { TaskComposer } from "./components/TaskComposer";
import { AppNavRail, APP_NAV_ITEMS, type AppNavView } from "./components/AppNavRail";
import {
  extractPendingApprovals,
  extractCompletedDiff,
  parseRepoName,
} from "./ui-helpers";
import type { RetainedRun, ToolRunRecord } from "./types";

const ORCHESTRATOR_AGENT = "coding-orchestrator";

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

type MainView = AppNavView;

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
  const [mainView, setMainView] = useState<MainView>("tasks");
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("live");
  // Workspace starts collapsed below lg so the drawer doesn't cover the
  // conversation on small screens; expanded by default on desktop.
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(() =>
    typeof window !== "undefined"
      ? window.matchMedia("(max-width: 1023px)").matches
      : false,
  );
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("runs");
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);

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
      if (!repoUrl.trim().startsWith("https://github.com/")) {
        setNotice("Repository URL must be a GitHub URL like https://github.com/owner/repo.");
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

  // Devin-style session list: the live chat session first, then retained and
  // in-flight delegated runs newest-first.
  const sessions = useMemo<SessionItem[]>(() => {
    const items: SessionItem[] = [
      {
        id: "live",
        title:
          task.trim() ||
          (chat.messages.length > 0 ? "Current session" : "New coding task"),
        repoName: repoUrl.trim() ? parseRepoName(repoUrl) : "no repository",
        status:
          pendingApprovals.length > 0
            ? "waiting-approval"
            : chat.isStreaming || chat.status === "streaming"
            ? "running"
            : "live",
        updatedAt: Date.now(),
        live: true,
      },
    ];
    const seen = new Set<string>();
    for (const run of retainedRuns) {
      seen.add(run.runId);
      items.push({
        id: run.runId,
        title: run.task,
        repoName: parseRepoName(run.repoUrl),
        status: run.status,
        updatedAt: run.updatedAt || run.createdAt,
      });
    }
    for (const run of toolRuns) {
      if (seen.has(run.runId)) continue;
      items.push({
        id: run.runId,
        title: `Delegated run ${run.runId.slice(0, 8)}`,
        repoName: run.agentType ?? "sandbox",
        status: run.status,
        updatedAt: Date.now(),
      });
    }
    return items;
  }, [
    task,
    repoUrl,
    chat.messages.length,
    chat.isStreaming,
    chat.status,
    pendingApprovals.length,
    retainedRuns,
    toolRuns,
  ]);

  // The center pane always shows the live chat session; picking a sidebar
  // row selects that run inside the workspace panel (VM / Diff / Runs tabs).
  const liveSession = sessions[0];

  const handleSelectSession = useCallback((id: string) => {
    setSelectedSessionId(id);
    setMobileSessionsOpen(false);
    if (id !== "live") {
      setSelectedRunId(id);
      setWorkspaceCollapsed(false);
      setWorkspaceTab("vm");
    }
  }, []);

  const handleNewTask = useCallback(() => {
    setSelectedSessionId("live");
    setMobileSessionsOpen(false);
    setMainView("tasks");
    window.setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')
        ?.focus();
    }, 0);
  }, []);

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

  return (
    <div className="min-h-dvh bg-black text-[#e6edf3] font-sans selection:bg-[#63c8c1] selection:text-black flex">
      {/* LEFT: app navigation rail (all views) */}
      <AppNavRail
        activeView={mainView}
        onNavigate={setMainView}
        activeSandboxCount={activeSandboxCount}
        setupDone={setupDone}
        setupTotal={SETUP_TOTAL_STEPS}
        onOpenSetup={() => setShowOnboardingModal(true)}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* SLIM CONTEXT HEADER */}
      <header className="h-14 border-b border-white/[0.08] bg-[#07090e]/95 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between gap-3 z-20 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="text-sm font-semibold text-white font-display tracking-tight">
            {APP_NAV_ITEMS.find((item) => item.id === mainView)?.label ?? "Tasks"}
          </span>
          <span className="text-[10px] font-mono text-teal-400 bg-teal-950/60 border border-teal-800/60 px-1.5 py-0.5 rounded">
            Cloudflare Native
          </span>
        </div>

        <div className="flex items-center gap-3 sm:gap-4">
          {/* Active Sandboxes Pill */}
          <div className="hidden sm:inline-flex items-center gap-1.5 border border-white/[0.08] bg-[#0d1117] rounded-full px-2.5 py-1 text-xs font-mono text-[#8b98a9] shadow-sm whitespace-nowrap">
            <span className={`w-1.5 h-1.5 rounded-full ${activeSandboxCount > 0 ? "bg-[#4f9cf0] animate-pulse" : "bg-zinc-600"}`} />
            <span>{activeSandboxCount} / 5 sandboxes active</span>
          </div>

          {/* Connection Status */}
          <div
            className="inline-flex items-center gap-2 border border-white/[0.08] bg-[#0d1117] rounded-full px-3 py-1 text-xs font-medium text-[#8b98a9] shadow-sm max-w-[240px]"
            role="status"
            aria-live="polite"
            title={connectionState}
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
            <span className="truncate">{connectionState}</span>
          </div>
        </div>
      </header>

      {mainView === "tasks" ? (
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT: Devin-style sessions rail */}
        <div className="hidden lg:block self-stretch">
          <SessionsSidebar
            sessions={sessions}
            selectedId={selectedSessionId}
            onSelect={handleSelectSession}
            onNewTask={handleNewTask}
            connectionLabel={connectionState}
            connectionTone={
              identityError || agent.connectionError
                ? "error"
                : agent.identified
                ? "ok"
                : "pending"
            }
            setupDone={setupDone}
            setupTotal={SETUP_TOTAL_STEPS}
            onOpenSetup={() => setShowOnboardingModal(true)}
          />
        </div>

        {/* Mobile sessions drawer (below lg) */}
        {mobileSessionsOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setMobileSessionsOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 shadow-2xl">
              <SessionsSidebar
                sessions={sessions}
                selectedId={selectedSessionId}
                onSelect={handleSelectSession}
                onNewTask={handleNewTask}
                connectionLabel={connectionState}
                connectionTone={
                  identityError || agent.connectionError
                    ? "error"
                    : agent.identified
                    ? "ok"
                    : "pending"
                }
                setupDone={setupDone}
                setupTotal={SETUP_TOTAL_STEPS}
                onOpenSetup={() => {
                  setMobileSessionsOpen(false);
                  setShowOnboardingModal(true);
                }}
              />
            </div>
          </div>
        ) : null}

        {/* CENTER: conversation timeline + composer */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-black">
          {/* SESSION HEADER */}
          <div className="border-b border-white/[0.08] bg-[#07090e]/60 px-5 xl:px-6 py-2.5 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <button
                type="button"
                onClick={() => setMobileSessionsOpen(true)}
                aria-label="Open sessions"
                className="lg:hidden w-7 h-7 rounded-lg border border-white/[0.08] bg-[#0d1117] text-[#8b98a9] hover:text-white flex items-center justify-center transition-colors shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>
              <img
                src="/assets/mascot/pet-logo.png"
                alt="Shiba"
                className="w-6 h-6 rounded-full bg-white object-contain border border-teal-500/40 shrink-0"
              />
              <h1 className="text-sm font-semibold text-white font-display tracking-tight truncate">
                {liveSession ? liveSession.title : "New coding task"}
              </h1>
              <span className="text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 shrink-0 text-teal-300 border-teal-800/50 bg-teal-950/50">
                Live
              </span>
            </div>
            <div className="hidden md:flex items-center gap-4 text-xs font-mono text-[#8b98a9] shrink-0">
              <span>
                <span className="text-neutral-500">Active</span>{" "}
                <span className="text-teal-400 font-bold">{toolRuns.length}</span>
              </span>
              <span>
                <span className="text-neutral-500">Approvals</span>{" "}
                <span className={pendingApprovals.length > 0 ? "font-bold text-[#f59e0b]" : "font-bold text-neutral-400"}>
                  {pendingApprovals.length}
                </span>
              </span>
              <span>
                <span className="text-neutral-500">Runs</span>{" "}
                <span className="text-white font-bold">{allRuns.length}</span>
              </span>
              <span className="text-[10px] uppercase tracking-wider font-mono text-teal-400/80 bg-teal-950/60 border border-teal-800/40 px-2 py-0.5 rounded">
                Zero-Trust Boundary
              </span>
            </div>
          </div>

          {/* PENDING APPROVALS STRIP */}
          {(pendingApprovals.length > 0 || approvalAnnouncement) ? (
            <div className="bg-[#090b0e] border-b border-neutral-800 px-5 xl:px-6 py-3 flex items-center justify-between shadow-sm z-10 shrink-0">
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

          {/* NOTICES / ERRORS */}
          {notice || chat.error || runsError ? (
            <div className="px-5 xl:px-6 pt-3 flex flex-col gap-2 shrink-0">
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
            </div>
          ) : null}

          {/* TIMELINE (scrollable) */}
          <div className="flex-1 overflow-y-auto px-5 xl:px-8 py-5">
            <StepTimeline
              messages={chat.messages}
              isStreaming={chat.isStreaming || chat.status === "streaming"}
              pendingApprovals={pendingApprovals}
              decisions={decisions}
              onDecideApproval={decideApproval}
              starters={STARTER_TEMPLATES}
              onStarter={(starterTask) => {
                setTask(starterTask);
                if (!repoUrl) setRepoUrl("https://github.com/cloudflare/ai-chat");
              }}
            />
          </div>

          {/* COMPOSER (sticky bottom) */}
          <div className="border-t border-white/[0.08] bg-[#07090e]/60 px-5 xl:px-8 py-4 shrink-0">
            <TaskComposer
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
          </div>
        </main>

        {/* RIGHT: workspace panel */}
        <WorkspacePanel
          toolRuns={toolRuns}
          retainedRuns={retainedRuns}
          vmRuns={allRuns}
          pendingApprovals={pendingApprovals}
          decisions={decisions}
          onDecideApproval={decideApproval}
          onRefreshRuns={refreshRuns}
          onInspectVM={(id) => {
            setSelectedRunId(id);
            setWorkspaceCollapsed(false);
            setWorkspaceTab("vm");
          }}
          onCancelRun={cancelRun}
          onReuseParams={(run) => {
            setRepoUrl(run.repoUrl);
            setBaseBranch(run.baseBranch);
            setTask(run.task);
            setPublishPullRequest(run.publishPullRequest);
          }}
          selectedRunId={selectedRunId}
          onSelectRun={setSelectedRunId}
          collapsed={workspaceCollapsed}
          onToggleCollapsed={() => setWorkspaceCollapsed((current) => !current)}
          tab={workspaceTab}
          onTabChange={setWorkspaceTab}
        />
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
    </div>
  );
}
