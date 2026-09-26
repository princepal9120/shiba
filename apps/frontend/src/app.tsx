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
import { AgentsView } from "./components/AgentsView";
import { MissionsView } from "./components/MissionsView";
import { GatesView } from "./components/GatesView";
import { ArchitectureView } from "./components/ArchitectureView";
import { DashboardView } from "./components/DashboardView";
import { OnboardingModal, detectSetupSteps } from "./components/OnboardingModal";
import { SessionsSidebar, type SessionItem } from "./components/SessionsSidebar";
import { StepTimeline } from "./components/StepTimeline";
import { DiffView } from "./components/DiffView";
import { ApprovalsView } from "./components/ApprovalsView";
import { InboxTab } from "./components/InboxTab";
import { MemoryTab } from "./components/MemoryTab";
import { TaskComposer } from "./components/TaskComposer";
import { toast } from "sonner";
import { AppNavRail, APP_NAV_ITEMS, type AppNavView } from "./components/AppNavRail";
import { CommandMenu, type CommandItem } from "./components/ui/command-menu";
import { useTheme } from "./components/ThemeProvider";
import { Tooltip } from "./components/Tooltip";
import {
  extractPendingApprovals,
  extractCompletedDiff,
  parseRepoName,
} from "./ui-helpers";
import type { AgentPrincipal, RetainedRun, StoredApproval, ToolRunRecord } from "./types";

const ORCHESTRATOR_AGENT = "coding-orchestrator";

// Guard for single-key shortcuts: never fire while the user is typing.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(
    el?.closest?.("input, textarea, select, [contenteditable]"),
  );
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

/**
 * Live approval pointers from the orchestrator DO (`GET /api/approvals`).
 * These are the records Slack-card and queued-email approvals write —
 * separate from chat tool-part approvals, and the only surface where a
 * queued email send can be decided. Polls so cards disappear the moment
 * another surface (or a peer) resolves them.
 */
function useStoredApprovals(refreshToken: number): {
  approvals: StoredApproval[];
  decided: StoredApproval[];
  error: string | null;
} {
  const [approvals, setApprovals] = useState<StoredApproval[]>([]);
  const [decided, setDecided] = useState<StoredApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // A slow poll landing after a newer one must not repaint a resolved card.
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      fetch("/api/approvals")
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Approvals request failed: ${response.status}`);
          }
          const body = (await response.json()) as {
            approvals?: StoredApproval[];
            decided?: StoredApproval[];
          };
          if (!cancelled && seq > applied) {
            applied = seq;
            setApprovals(Array.isArray(body.approvals) ? body.approvals : []);
            setDecided(Array.isArray(body.decided) ? body.decided : []);
            setError(null);
          }
        })
        .catch((fetchError: unknown) => {
          if (!cancelled && seq > applied) {
            setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
          }
        });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshToken]);

  return { approvals, decided, error };
}

// Registered MCP-token principals, polled on the same cadence as stored
// approvals. No error surface: a failed poll just keeps the last list —
// the sidebar Agents group is informational, not a decision surface.
function useAgentPrincipals(refreshToken: number): AgentPrincipal[] {
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);

  useEffect(() => {
    let cancelled = false;
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      fetch("/api/agents")
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Agents request failed: ${response.status}`);
          }
          const body = (await response.json()) as { principals?: AgentPrincipal[] };
          if (!cancelled && seq > applied) {
            applied = seq;
            setPrincipals(Array.isArray(body.principals) ? body.principals : []);
          }
        })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refreshToken]);

  return principals;
}

type IdentityIssue = "signin" | "unreachable" | "error";
type IdentityResult = { agent: string } | { issue: IdentityIssue; message: string };

async function fetchIdentity(): Promise<IdentityResult> {
  let res: Response;
  try {
    // manual: Cloudflare Access answers an expired session with a cross-origin
    // login redirect, which would otherwise surface as an opaque CORS failure.
    res = await fetch("/api/whoami", { redirect: "manual", cache: "no-store" });
  } catch {
    return { issue: "unreachable", message: "Network error reaching /api/whoami." };
  }
  if (res.type === "opaqueredirect" || res.status === 401) {
    return { issue: "signin", message: "Sign-in required." };
  }
  // Non-JSON means something other than the Worker answered (static host, dev proxy).
  const body = (await res.json().catch(() => null)) as { agent?: unknown } | null;
  if (body === null || res.status === 404 || res.status === 502 || res.status === 503 || res.status === 504) {
    return { issue: "unreachable", message: `GET /api/whoami returned ${res.status}.` };
  }
  if (!res.ok) return { issue: "error", message: `GET /api/whoami failed with ${res.status}.` };
  return typeof body.agent === "string" && body.agent !== ""
    ? { agent: body.agent }
    : { issue: "error", message: "The server did not return an agent identity." };
}

// Live tool-run records carry the delegate call's input, not a typed payload.
function toolRunInput(run: ToolRunRecord): Record<string, unknown> {
  const preview = run.inputPreview;
  return typeof preview === "object" && preview !== null && !Array.isArray(preview)
    ? (preview as Record<string, unknown>)
    : {};
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

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showClearModal, setShowClearModal] = useState(false);
  const [showShortcutsModal, setShowShortcutsModal] = useState(false);
  const [commandMenuOpen, setCommandMenuOpen] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();
  const theme = (resolvedTheme === "light" ? "light" : "dark") as "dark" | "light";
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");

  useEffect(() => {
    document.title = "Shiba Dashboard · Self-Hosted AI Software Engineer";
  }, []);

  // Surface transient notices through the toast channel (aria-live inside sonner).
  useEffect(() => {
    if (notice) toast(notice);
  }, [notice]);
  const [showOnboardingModal, setShowOnboardingModal] = useState(false);
  const [mainView, setMainView] = useState<MainView>("tasks");
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("live");
// Persistent workspace panel removed from tasks view; functionality promoted to standalone views.
  const [mobileSessionsOpen, setMobileSessionsOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mobileNavTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Return focus to the hamburger after the sheet unmounts, so Esc/backdrop
  // closes don't strand keyboard users on a removed element. Skip the first
  // run — the sheet never opened — or the hamburger steals focus on load.
  const mobileNavWasOpen = useRef(false);
  useEffect(() => {
    if (mobileNavOpen) {
      mobileNavWasOpen.current = true;
    } else if (mobileNavWasOpen.current) {
      mobileNavTriggerRef.current?.focus();
    }
  }, [mobileNavOpen]);
  const [sessionsCollapsed, setSessionsCollapsed] = useState(() =>
    typeof window !== "undefined"
      ? localStorage.getItem("shiba-ai-coworker:sidebar-collapsed") === "true"
      : false,
  );

  const toggleSessionsCollapsed = useCallback(() => {
    setSessionsCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("shiba-ai-coworker:sidebar-collapsed", String(next));
        } catch {
          // Ignore storage quota or access errors in private mode
        }
      }
      return next;
    });
  }, []);

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
      } else if (tabParam === "dashboard") {
        setMainView("dashboard");
      } else if (tabParam === "vm" || tabParam === "vm-inspector") {
        setMainView("vm");
      } else if (tabParam === "runs" || tabParam === "run-registry") {
        setMainView("runs");
      } else if (tabParam === "diff") {
        setMainView("diff");
      } else if (tabParam === "approvals") {
        setMainView("approvals");
      } else if (tabParam === "inbox" || tabParam === "mailbox") {
        setMainView("inbox");
      } else if (tabParam === "memory") {
        setMainView("memory");
      } else if (tabParam === "automations") {
        setMainView("automations");
      } else if (tabParam === "agents") {
        setMainView("agents");
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
  const [identityIssue, setIdentityIssue] = useState<IdentityIssue | null>(null);
  // Bumping this re-runs the whoami check (retry timer, "Retry now", wake-up).
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const identityFailures = useRef(0);
  const retryIdentity = useCallback(() => setIdentityAttempt((n) => n + 1), []);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    void fetchIdentity().then((result) => {
      if (cancelled) return;
      if ("agent" in result) {
        identityFailures.current = 0;
        setOrchestratorName(result.agent);
        setIdentityError(null);
        setIdentityIssue(null);
        return;
      }
      setIdentityError(result.message);
      setIdentityIssue(result.issue);
      if (result.issue === "signin") return;
      const delay = Math.min(30_000, 1_000 * 2 ** identityFailures.current);
      identityFailures.current += 1;
      timer = window.setTimeout(() => setIdentityAttempt((n) => n + 1), delay);
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [identityAttempt]);

  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );

  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT,
    // Until /api/whoami resolves, bind to a private placeholder DO — `agents`
    // defaults a missing name to the shared "default" instance, where chat
    // approvals would be decidable by any other pending dashboard.
    name: orchestratorName ?? "identity-pending",
  });
  const chat = useAgentChat({
    agent,
    onError: () => {
      submitFailed.current = true;
    },
  });
  const { runsById } = useAgentToolEvents({ agent });
  const { runs: retainedRuns, error: runsError } = useRetainedRuns(refreshToken);
  const {
    approvals: storedApprovals,
    decided: decidedStoredApprovals,
    error: storedApprovalsError,
  } = useStoredApprovals(refreshToken);
  const agentPrincipals = useAgentPrincipals(refreshToken);

  const toolRuns = useMemo(() => Object.values(runsById) as ToolRunRecord[], [runsById]);

  const pendingApprovals = useMemo(
    () => extractPendingApprovals(chat.messages),
    [chat.messages],
  );

  // A chat-queued approval's DO pointer is the same record — the chat
  // card is the decision surface, so stored pointers already shown as
  // chat cards must not double-render or double-count in badges.
  const visibleStoredApprovals = useMemo(() => {
    const chatIds = new Set(pendingApprovals.map((approval) => approval.approvalId));
    return storedApprovals.filter((approval) => !chatIds.has(approval.approvalId));
  }, [storedApprovals, pendingApprovals]);

  const decidedRef = useRef<Set<string>>(new Set());
  const decidedStoredRef = useRef<Set<string>>(new Set());

  const refreshRuns = useCallback(() => setRefreshToken((token) => token + 1), []);

  // Waking from background or regaining network: reconnect now instead of
  // waiting out the socket's backoff, and refetch runs/approvals/identity.
  const hiddenAt = useRef<number | null>(null);
  useEffect(() => {
    const revive = (force: boolean) => {
      if (force || agent.readyState !== WebSocket.OPEN) agent.reconnect();
      refreshRuns();
      retryIdentity();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        return;
      }
      const hiddenFor = hiddenAt.current === null ? 0 : Date.now() - hiddenAt.current;
      hiddenAt.current = null;
      // iOS freezes background sockets without closing them, so readyState can lie.
      revive(hiddenFor > 15_000);
    };
    const onOnline = () => {
      setOnline(true);
      revive(true);
    };
    const onOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [agent, refreshRuns, retryIdentity]);

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

  const [storedDecisions, setStoredDecisions] = useState<Record<string, boolean>>({});

  // Drop decision bookkeeping for stored approvals that left the list.
  useEffect(() => {
    const waiting = new Set(storedApprovals.map((approval) => approval.approvalId));
    for (const id of Array.from(decidedStoredRef.current)) {
      if (!waiting.has(id)) decidedStoredRef.current.delete(id);
    }
    setStoredDecisions((current) => {
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
  }, [storedApprovals]);

  // Decide a DO-state approval pointer: POST resolves it in place — the
  // frozen payload executes or the queued draft is released.
  const decideStoredApproval = useCallback(
    async (approval: StoredApproval, approved: boolean) => {
      const approvalId = approval.approvalId;
      if (decidedStoredRef.current.has(approvalId)) return;
      decidedStoredRef.current.add(approvalId);
      setStoredDecisions((current) => ({ ...current, [approvalId]: approved }));
      try {
        const response = await fetch("/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            threadKey: approval.threadKey,
            approvalId,
            approved,
          }),
        });
        const body = (await response.json().catch(() => ({}))) as {
          result?: string;
          error?: string;
        };
        if (!response.ok) {
          throw new Error(body.error ?? `Approval request failed: ${response.status}`);
        }
        if (body.result === "unknown") {
          throw new Error(
            "The approval is gone — it expired or was already decided elsewhere.",
          );
        }
        setApprovalAnnouncement(
          approved
            ? "Approved — the request is executing."
            : "Rejected — nothing will execute.",
        );
        setNotice(null);
      } catch (decisionError) {
        decidedStoredRef.current.delete(approvalId);
        setStoredDecisions((current) => {
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
      refreshRuns();
    },
    [refreshRuns],
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
      if (!orchestratorName) {
        setNotice(identityError
          ? `Task not sent: agent identity failed to resolve (${identityError}).`
          : "Task not sent: still resolving your agent identity.");
        return;
      }
      // Without a live agent connection sendMessage resolves silently, so the
      // task would vanish as if it had been accepted.
      if (agent.connectionError || !agent.identified) {
        setNotice(
          `Task not sent: ${
            agent.connectionError
              ? `connection error: ${agent.connectionError.message ?? "unknown"}`
              : "still connecting to the orchestrator"
          }.`,
        );
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
      setIsSubmitting(true);
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
        setIsSubmitting(false);
      }
    },
    [repoUrl, baseBranch, task, publishPullRequest, harness, chat, agent, orchestratorName, identityError, refreshRuns],
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
      if (e.key === "Escape") {
        setShowClearModal(false);
        setShowShortcutsModal(false);
        setShowOnboardingModal(false);
        setMobileSessionsOpen(false);
        setMobileNavOpen(false);
        setCommandMenuOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (!isSubmitting && repoUrl.trim() && task.trim()) {
          e.preventDefault();
          submitTask();
        }
        return;
      }
      if (isEditableTarget(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandMenuOpen((prev) => !prev);
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleSessionsCollapsed();
      } else if (
        e.key.toLowerCase() === "d" &&
        !e.metaKey && !e.ctrlKey && !e.altKey
      ) {
        toggleTheme();
      } else if (e.key === "[") {
        e.preventDefault();
        toggleSessionsCollapsed();
      } else if (e.key === "?") {
        setShowShortcutsModal((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, repoUrl, task, submitTask, toggleSessionsCollapsed, toggleTheme]);

  // First-seen time per live run: a stable createdAt so ordering doesn't churn.
  const firstSeen = useRef(new Map<string, number>());
  const seenAt = useCallback((runId: string) => {
    let at = firstSeen.current.get(runId);
    if (at === undefined) {
      at = Date.now();
      firstSeen.current.set(runId, at);
    }
    return at;
  }, []);

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
        const input = toolRunInput(tr);
        const at = seenAt(tr.runId);
        map.set(tr.runId, {
          runId: tr.runId,
          sandboxId: tr.runId,
          repoUrl: typeof input.repoUrl === "string" ? input.repoUrl : "",
          task: typeof input.task === "string" ? input.task : `Delegated run ${tr.runId.slice(0, 8)}`,
          baseBranch: typeof input.baseBranch === "string" ? input.baseBranch : "main",
          publishPullRequest: input.publishPullRequest === true,
          status: tr.status || "running",
          createdAt: at,
          updatedAt: at,
          summary: tr.summary,
          error: tr.error,
          diff: completedDiff || undefined,
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.createdAt - a.createdAt);
  }, [retainedRuns, toolRuns, seenAt]);

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
      const input = toolRunInput(run);
      items.push({
        id: run.runId,
        title: typeof input.task === "string" ? input.task : `Delegated run ${run.runId.slice(0, 8)}`,
        repoName:
          typeof input.repoUrl === "string" ? parseRepoName(input.repoUrl) : run.agentType ?? "sandbox",
        status: run.status,
        updatedAt: seenAt(run.runId),
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
    seenAt,
  ]);

  // The center pane always shows the live chat session; picking a sidebar
  // row selects that run inside the workspace panel (VM / Diff / Runs tabs).
  const liveSession = sessions[0];

  const handleSelectSession = useCallback((id: string) => {
    setSelectedSessionId(id);
    setMobileSessionsOpen(false);
    if (id !== "live") {
      setSelectedRunId(id);
      setMainView("vm");
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

  const busy = isSubmitting || clearing || chat.isStreaming || chat.status === "streaming" || chat.status === "submitted";

  const commands: CommandItem[] = [
    ...APP_NAV_ITEMS.map((item) => ({
      id: `nav-${item.id}`,
      label: `Go to ${item.label}`,
      hint: item.description,
      run: () => setMainView(item.id),
    })),
    { id: "new-task", label: "New task", run: handleNewTask },
    {
      id: "toggle-sessions",
      label: "Toggle sessions sidebar",
      hint: "⌘B",
      run: toggleSessionsCollapsed,
    },
    {
      id: "toggle-theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      hint: "D",
      run: toggleTheme,
    },
    {
      id: "setup-guide",
      label: "Open setup guide",
      run: () => setShowOnboardingModal(true),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      hint: "?",
      run: () => setShowShortcutsModal(true),
    },
  ];

  if (identityIssue === "signin") {
    return (
      <div className="h-dvh bg-[#f6f4ed] text-[#222320] font-sans flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none max-w-sm w-full p-6 shadow-[3px_3px_0_var(--paper-shadow)] flex flex-col items-center text-center gap-3">
          <img
            src="/assets/mascot/pet-logo.png"
            alt="Shiba"
            className="size-14 rounded-full bg-white object-contain border border-[#0000a8]/40"
          />
          <h1 className="text-2xl text-[#222320]">Sign in to continue</h1>
          <p className="text-sm text-[#6a6f63] leading-relaxed">
            Your Cloudflare Access session has expired or you are not signed in yet.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-1 w-full min-h-11 rounded-none bg-[#0000a8] hover:bg-[#1c1cc8] text-white text-sm font-semibold transition-colors shadow-[2px_2px_0_var(--paper-shadow)] active:scale-[0.98]"
          >
            Sign in
          </button>
        </div>
      </div>
    );
  }

  const bannerMessage = !online
    ? "You're offline. Changes will sync when the network returns."
    : identityIssue === "unreachable"
      ? "Backend not connected — open your Worker URL."
      : identityIssue === "error"
        ? `Identity lookup failed: ${identityError ?? "unknown error"}`
        : orchestratorName && agent.connectionError
          ? `Live connection lost: ${agent.connectionError.message ?? "unknown"}. Reconnecting…`
          : null;

  return (
    <div className="h-dvh overflow-hidden bg-[#f6f4ed] text-[#222320] font-sans selection:bg-[#0000a8] selection:text-white flex pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* LEFT: app navigation rail (lg+; phones use the sheet below) */}
      <AppNavRail
        activeView={mainView}
        onNavigate={(view) => setMainView(view)}
        pendingApprovalCount={pendingApprovals.length + visibleStoredApprovals.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        activeSandboxCount={activeSandboxCount}
        setupDone={setupDone}
        setupTotal={SETUP_TOTAL_STEPS}
        onOpenSetup={() => setShowOnboardingModal(true)}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
      />

      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-black/60"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 shadow-[3px_3px_0_var(--paper-shadow)] animate-enter-x">
            <AppNavRail
              variant="sheet"
              activeView={mainView}
              onNavigate={(view) => {
                setMainView(view);
                setMobileNavOpen(false);
              }}
              pendingApprovalCount={pendingApprovals.length + visibleStoredApprovals.length}
              theme={theme}
              onToggleTheme={toggleTheme}
              activeSandboxCount={activeSandboxCount}
              setupDone={setupDone}
              setupTotal={SETUP_TOTAL_STEPS}
              onOpenSetup={() => {
                setMobileNavOpen(false);
                setShowOnboardingModal(true);
              }}
              onOpenShortcuts={() => {
                setMobileNavOpen(false);
                setShowShortcutsModal(true);
              }}
              onClose={() => setMobileNavOpen(false)}
            />
          </div>
        </div>
      ) : null}

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* NAVY TOP BAR — bezalel-style breadcrumb + quick actions */}
      <header className="h-[calc(2.75rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0 bg-[#0000a8] text-white flex items-center gap-2.5 pl-2 pr-3 lg:px-4 z-20">
        <button
          type="button"
          ref={mobileNavTriggerRef}
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
          aria-expanded={mobileNavOpen}
          className="lg:hidden size-11 -my-1 shrink-0 rounded-none flex items-center justify-center text-white/90 hover:bg-white/15 transition-colors"
        >
          <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-white/60">
            Shiba
          </span>
          <span className="text-white/40 text-xs" aria-hidden="true">/</span>
          <span className="text-[13px] font-medium truncate">
            {APP_NAV_ITEMS.find((item) => item.id === mainView)?.label ?? "Tasks"}
          </span>
        </nav>
        <div className="ml-auto flex items-center gap-1.5">
          <Tooltip content="Command menu" shortcut="⌘K" side="bottom">
            <button
              type="button"
              onClick={() => setCommandMenuOpen(true)}
              aria-label="Open command menu"
              className="h-7 touch:h-9 touch:min-w-11 justify-center rounded-none border border-white/20 bg-white/10 text-white/90 hover:bg-white/20 hover:text-white flex items-center gap-1.5 px-2 text-[11px] font-medium transition-colors"
            >
              <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z" />
              </svg>
              <span className="font-mono text-[10px] text-white/60">⌘K</span>
            </button>
          </Tooltip>
        </div>
      </header>

      {bannerMessage ? (
        <div
          role="alert"
          className="shrink-0 flex items-center gap-3 px-4 py-2 bg-[#fb2c36]/10 border-b border-[#fb2c36]/30 text-xs text-[#b91c1c]"
        >
          <span className="size-2 shrink-0 rounded-full bg-[#fb2c36] animate-pulse" aria-hidden="true" />
          <span className="flex-1 min-w-0 break-words">
            {bannerMessage}
            {online && identityIssue ? (
              <span className="text-[#6a6f63]"> Retrying automatically.</span>
            ) : null}
          </span>
          <button
            type="button"
            onClick={() => {
              if (identityIssue) retryIdentity();
              else agent.reconnect();
            }}
            className="shrink-0 touch:min-h-11 px-3 py-1 rounded-none border border-[#fb2c36]/40 bg-[#fffef8] text-[#b91c1c] font-medium hover:bg-[#fb2c36]/10 transition-colors"
          >
            Retry now
          </button>
        </div>
      ) : null}

      <div className="flex-1 flex min-w-0 min-h-0">
      {mainView === "dashboard" ? (
        <DashboardView
          runs={retainedRuns}
          pendingApprovals={pendingApprovals}
          storedApprovals={visibleStoredApprovals}
          agents={agentPrincipals}
          connectionLabel={connectionState}
          connectionTone={identityError || agent.connectionError ? "error" : agent.identified ? "ok" : "pending"}
          runsError={runsError}
          onNavigate={(view) => setMainView(view)}
          onNewTask={handleNewTask}
          onInspectRun={(runId) => {
            setSelectedRunId(runId);
            setMainView("vm");
          }}
        />
      ) : mainView === "tasks" ? (
      <div className="flex-1 flex overflow-hidden">
        {/* LEFT: Devin-style sessions rail with collapse / expand */}
        <div
          className={`hidden lg:block self-stretch transition-all duration-200 ease-out overflow-hidden shrink-0 ${
            sessionsCollapsed ? "w-0 opacity-0 pointer-events-none" : "w-[280px] opacity-100"
          }`}
          aria-hidden={sessionsCollapsed}
        >
          <SessionsSidebar
            sessions={sessions}
            agents={agentPrincipals}
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
            onToggleCollapse={toggleSessionsCollapsed}
          />
        </div>

        {/* Mobile sessions drawer (below lg) */}
        {mobileSessionsOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="Close sessions"
              className="absolute inset-0 bg-black/60"
              onClick={() => setMobileSessionsOpen(false)}
            />
            <div className="absolute inset-y-0 left-0 shadow-[3px_3px_0_var(--paper-shadow)] bg-[#f6f4ed] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] animate-enter-x">
              <SessionsSidebar
                sessions={sessions}
                agents={agentPrincipals}
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
                isMobileDrawer={true}
                onToggleCollapse={() => setMobileSessionsOpen(false)}
              />
            </div>
          </div>
        ) : null}

        {/* CENTER: conversation timeline + composer */}
        <main className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[#f6f4ed]" aria-busy={busy}>
          {/* SESSION HEADER */}
          <div className="border-b border-black/[0.08] bg-[#f6f4ed]/60 px-3 sm:px-5 xl:px-6 py-2.5 flex items-center justify-between gap-3 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {/* Desktop sidebar toggle button */}
              <Tooltip
                content={sessionsCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                shortcut="⌘B"
                side="bottom"
              >
                <button
                  type="button"
                  onClick={toggleSessionsCollapsed}
                  aria-label={sessionsCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                  aria-expanded={!sessionsCollapsed}
                  className="hidden lg:flex w-7 h-7 rounded-none border border-black/[0.08] bg-[#fffef8] text-[#6a6f63] hover:text-[#222320] hover:bg-[#e0ded5] items-center justify-center transition-colors shrink-0"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    {sessionsCollapsed ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M13 5l7 7-7 7M5 5l7 7-7 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                    )}
                  </svg>
                </button>
              </Tooltip>

              {/* Mobile open sessions button */}
              <Tooltip content="Open sessions drawer" side="bottom">
              <button
                type="button"
                onClick={() => setMobileSessionsOpen(true)}
                aria-label="Open sessions"
                className="lg:hidden w-7 h-7 touch:w-11 touch:h-11 rounded-none border border-black/[0.08] bg-[#fffef8] text-[#6a6f63] hover:text-[#222320] flex items-center justify-center transition-colors shrink-0"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </button>
              </Tooltip>

              <Tooltip content="Shiba Coding Agent" side="bottom">
              <img
                src="/assets/mascot/pet-logo.png"
                alt="Shiba"
                className="w-6 h-6 rounded-full bg-white object-contain border border-[#0000a8]/40 shrink-0 cursor-default"
              />
              </Tooltip>
              <h1 className="text-sm font-semibold text-[#222320] font-display tracking-tight truncate">
                {liveSession ? liveSession.title : "New coding task"}
              </h1>
              <Tooltip content="Active real-time agent orchestration stream" side="bottom">
              <span className="text-[10px] font-bold uppercase tracking-wider border rounded-none px-2 py-0.5 shrink-0 text-[#1c1cc8] border-[#0000a8]/15 bg-[#0000a8]/10">
                Live
              </span>
              </Tooltip>
            </div>

            <div className="hidden md:flex items-center gap-4 text-xs font-mono text-[#6a6f63] shrink-0">
              <Tooltip content="Tool runs currently in flight" side="bottom">
              <span className="cursor-default">
                <span className="text-[#6a6f63]">Active</span>{" "}
                <span className="text-[#0000a8] font-bold">{toolRuns.length}</span>
              </span>
              </Tooltip>
              <Tooltip content="Actions waiting for human approval" side="bottom">
              <span className="cursor-default">
                <span className="text-[#6a6f63]">Approvals</span>{" "}
                <span className={pendingApprovals.length + visibleStoredApprovals.length > 0 ? "font-bold text-[#f99c00]" : "font-bold text-[#6a6f63]"}>
                  {pendingApprovals.length + visibleStoredApprovals.length}
                </span>
              </span>
              </Tooltip>
              <Tooltip content="Total completed and retained runs" side="bottom">
              <span className="cursor-default">
                <span className="text-[#6a6f63]">Runs</span>{" "}
                <span className="text-[#222320] font-bold">{allRuns.length}</span>
              </span>
              </Tooltip>
              <Tooltip content="Container has zero secrets; provider keys stay at AI Gateway egress" side="bottom">
              <span className="text-[10px] uppercase tracking-wider font-mono text-[#0000a8]/80 bg-[#0000a8]/10 border border-[#0000a8]/10 px-2 py-0.5 rounded-none">
                Zero-Trust Boundary
              </span>
              </Tooltip>

            </div>
          </div>

          {/* PENDING APPROVALS STRIP */}
          {(pendingApprovals.length + visibleStoredApprovals.length > 0 || approvalAnnouncement) ? (
            <div className="bg-[#fffef8] border-b border-[#e0ded5] px-3 sm:px-5 xl:px-6 py-3 flex items-center justify-between gap-3 shadow-[2px_2px_0_var(--paper-shadow)] z-10 shrink-0">
              <p className="text-sm font-medium text-[#222320]" role="status" aria-live="polite">
                {pendingApprovals.length + visibleStoredApprovals.length > 0 ? (
                  <span className="flex items-center gap-2 text-[#b45309]">
                    <span className="w-2.5 h-2.5 rounded-full bg-[#b45309] animate-pulse" />
                    {pendingApprovals.length + visibleStoredApprovals.length} task{pendingApprovals.length + visibleStoredApprovals.length === 1 ? "" : "s"} waiting for your approval.
                  </span>
                ) : (
                  <span className="text-[#15803d] flex items-center gap-2">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    {approvalAnnouncement}
                  </span>
                )}
              </p>
              {visibleStoredApprovals.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setMainView("approvals")}
                  className="shrink-0 text-xs font-semibold text-[#b45309] border border-[#b45309]/40 bg-[#b45309]/10 hover:bg-[#b45309]/15 rounded-none px-3 py-1.5 touch:min-h-11 transition-colors"
                >
                  Review
                </button>
              ) : null}
            </div>
          ) : null}

          {/* NOTICES / ERRORS */}
          {notice || chat.error || runsError ? (
            <div className="px-3 sm:px-5 xl:px-6 pt-3 flex flex-col gap-2 shrink-0">
              {notice ? (
                <div role="status" aria-live="polite" className="text-xs text-[#6a6f63] bg-[#fffef8] p-3 rounded-none border border-[#e0ded5] flex items-start gap-2">
                  <svg className="w-4 h-4 text-[#0000a8] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="break-words">{notice}</div>
                </div>
              ) : null}
              {chat.error ? (
                <div role="alert" className="text-xs text-[#fb2c36] bg-[#fb2c36]/10 p-3 rounded-none border border-[#fb2c36]/30 flex items-start gap-2">
                  <svg className="w-4 h-4 text-[#fb2c36] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div className="break-words">Chat error: {chat.error.message}</div>
                </div>
              ) : null}
              {runsError ? (
                <div className="text-xs text-[#fb2c36] bg-[#fb2c36]/10 p-3 rounded-none border border-[#fb2c36]/30 flex items-start gap-2">
                  <svg className="w-4 h-4 text-[#fb2c36] shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <div className="break-words">Runs registry: {runsError}</div>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* TIMELINE (scrollable) */}
          <div className="flex-1 overflow-y-auto overscroll-contain px-3 sm:px-5 xl:px-8 py-5">
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
          <div className="border-t border-black/[0.08] bg-[#f6f4ed]/60 px-3 sm:px-5 xl:px-8 pt-3 sm:pt-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] shrink-0">
            <TaskComposer
              repoUrl={repoUrl}
              task={task}
              baseBranch={baseBranch}
              publishPullRequest={publishPullRequest}
              harness={harness}
              busy={busy}
              isSubmitting={isSubmitting}
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
      ) : mainView === "diff" ? (
        <DiffView
          runs={allRuns}
          selectedRunId={selectedRunId}
          onSelectRun={(id) => setSelectedRunId(id)}
          onInspectVM={(id) => {
            setSelectedRunId(id);
            setMainView("vm");
          }}
        />
      ) : mainView === "approvals" ? (
        <ApprovalsView
          pendingApprovals={pendingApprovals}
          decisions={decisions}
          onDecideApproval={decideApproval}
          storedApprovals={visibleStoredApprovals}
          storedDecisions={storedDecisions}
          decidedStoredApprovals={decidedStoredApprovals}
          storedApprovalsError={storedApprovalsError}
          onDecideStoredApproval={decideStoredApproval}
          orchestratorName={orchestratorName}
          onRefresh={refreshRuns}
        />
      ) : mainView === "inbox" ? (
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
          <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
                <span>Mailbox</span>
              </h2>
              <p className="text-xs text-[#6a6f63]">
                Cloudflare Email Routing, inbound triage, and approval-gated outbound send.
              </p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 lg:p-8">
            <div className="max-w-6xl mx-auto">
              <InboxTab onOpenApprovals={() => setMainView("approvals")} />
            </div>
          </div>
        </div>
      ) : mainView === "memory" ? (
        <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
          <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
                <span>Agent Memory</span>
              </h2>
              <p className="text-xs text-[#6a6f63]">
                Vectorize long-term semantic memory, extracted facts, and session context.
              </p>
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-4 lg:p-8">
            <div className="max-w-6xl mx-auto">
              <MemoryTab />
            </div>
          </div>
        </div>
      ) : mainView === "automations" ? (
        <AutomationsView />
      ) : mainView === "agents" ? (
        <AgentsView />
      ) : mainView === "missions" ? (
        <MissionsView />
      ) : mainView === "gates" ? (
        <GatesView />
      ) : (
        <ArchitectureView />
      )}

      {/* CLEAR HISTORY CONFIRMATION MODAL */}
      {showClearModal ? (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none max-w-md w-full p-6 shadow-[3px_3px_0_var(--paper-shadow)]">
            <h3 className="text-lg font-bold text-[#222320] mb-2">Clear Conversation & Runs?</h3>
            <p className="text-sm text-[#6a6f63] mb-5 leading-relaxed">
              This will erase all active conversation history and delete retained run registry records on the orchestrator. Active sandboxes will not be destroyed automatically.
            </p>
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                className="px-4 py-2 rounded-none text-sm font-medium text-[#6a6f63] hover:text-[#222320] bg-[#fffef8] border border-[#e0ded5] transition-colors"
                onClick={() => setShowClearModal(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-4 py-2 rounded-none text-sm font-semibold text-white bg-[#fb2c36] hover:bg-[#fb2c36]/90 transition-colors shadow-[2px_2px_0_var(--paper-shadow)]"
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
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-[#fffef8] border border-[#e0ded5] rounded-none max-w-md w-full p-6 shadow-[3px_3px_0_var(--paper-shadow)]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-base font-bold text-[#222320]">Keyboard Shortcuts</h3>
              <button
                type="button"
                onClick={() => setShowShortcutsModal(false)}
                className="text-[#6a6f63] hover:text-[#222320] text-sm font-mono"
              >
                ✕
              </button>
            </div>
            <div className="flex flex-col gap-2.5 text-xs">
              <div className="flex items-center justify-between py-1.5 border-b border-[#e0ded5]">
                <span className="text-[#6a6f63]">Submit Task</span>
                <span className="font-mono bg-[#fffef8] border border-[#e0ded5] px-2 py-0.5 rounded-none text-[#222320]">
                  ⌘ / Ctrl + Enter
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#e0ded5]">
                <span className="text-[#6a6f63]">Toggle Sessions Sidebar</span>
                <span className="font-mono bg-[#fffef8] border border-[#e0ded5] px-2 py-0.5 rounded-none text-[#222320]">
                  ⌘ / Ctrl + B  or  [
                </span>
              </div>

              <div className="flex items-center justify-between py-1.5 border-b border-[#e0ded5]">
                <span className="text-[#6a6f63]">Close Modals</span>
                <span className="font-mono bg-[#fffef8] border border-[#e0ded5] px-2 py-0.5 rounded-none text-[#222320]">
                  Escape
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#e0ded5]">
                <span className="text-[#6a6f63]">Open Shortcuts Guide</span>
                <span className="font-mono bg-[#fffef8] border border-[#e0ded5] px-2 py-0.5 rounded-none text-[#222320]">
                  ?
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#e0ded5]">
                <span className="text-[#6a6f63]">Command Menu</span>
                <span className="font-mono bg-[#fffef8] border border-[#e0ded5] px-2 py-0.5 rounded-none text-[#222320]">
                  ⌘ / Ctrl + K
                </span>
              </div>
              <div className="flex items-center justify-between py-1.5 border-b border-[#e0ded5]">
                <span className="text-[#6a6f63]">Toggle Light / Dark Theme</span>
                <span className="font-mono bg-[#fffef8] border border-[#e0ded5] px-2 py-0.5 rounded-none text-[#222320]">
                  D
                </span>
              </div>
            </div>
            <div className="mt-5 text-right">
              <button
                type="button"
                className="px-4 py-1.5 rounded-none text-xs font-medium text-[#222320] bg-[#fffef8] border border-[#e0ded5] hover:bg-[#e0ded5] transition-colors"
                onClick={() => setShowShortcutsModal(false)}
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <CommandMenu
        open={commandMenuOpen}
        onClose={() => setCommandMenuOpen(false)}
        commands={commands}
      />
      </div>
      </div>
    </div>
  );
}
