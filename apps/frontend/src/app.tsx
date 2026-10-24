/**
 * Complete End-to-End Shiba Dashboard.
 * Approval-gated coding tasks delegated to isolated Cloudflare Sandbox containers running OpenCode.
 */
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent, useAgentToolEvents } from "agents/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HARNESS_REASONING_EFFORTS, type ReasoningEffort } from "@shiba/shared";
import type { VMRun } from "./types";
import { ActivityView } from "./components/ActivityView";
import { ActivityReportView } from "./components/ActivityReportView";
import { SwarmDeskView } from "./components/SwarmDeskView";
import { AnalyticsView } from "./components/AnalyticsView";
import { AutomationsView } from "./components/AutomationsView";
import { AgentsView } from "./components/AgentsView";
import { ProvidersView } from "./components/ProvidersView";
import { SkillsView } from "./components/SkillsView";
import { CustomAgentsView, useCustomAgentOptions } from "./components/CustomAgentsView";
import { RemoteAccessView } from "./components/RemoteAccessView";
import { useSavedRepos, useSavedSkills, saveRepo, readDraft, writeDraft } from "./saved";
import { useSocketLiveness } from "./socket-liveness";
import {
  codingModelOptions,
  readyConnectionOptions,
  useAgentsDirectory,
  useModelConfig,
} from "./live-status";
import { DashboardView } from "./components/DashboardView";
import { OnboardingModal, detectSetupSteps } from "./components/OnboardingModal";
import { FirstRunWizard, ONBOARDING_STORAGE_KEY } from "./components/FirstRunWizard";
import { SessionsSidebar, type SessionItem } from "./components/SessionsSidebar";
import { StepTimeline } from "./components/StepTimeline";
import { DiffView } from "./components/DiffView";
import { ApprovalsView } from "./components/ApprovalsView";
import { InboxTab } from "./components/InboxTab";
import { IntegrationsView } from "./components/IntegrationsView";
import { MemoryTab } from "./components/MemoryTab";
import { SettingsModal } from "./components/SettingsModal";
import type { SettingsSectionId } from "./components/settings-sections";
import { TaskComposer } from "./components/TaskComposer";
import { PullRequestCard } from "./components/PullRequestCard";
import { ReviewFindings } from "./components/ReviewFindings";
import { RunUsageCard } from "./components/RunUsageSummary";
import { RunProgressCard } from "./components/RunProgressCard";
import { targetMachineFields, useDesktopStatus } from "./desktop-status";
import { toast } from "sonner";
import { BookOpen, FlaskConical, Sparkles, Zap } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { AppNavRail, APP_NAV_ITEMS, type AppNavView } from "./components/AppNavRail";
import { AuthScreen, SessionPending, SessionProblem } from "./components/AuthScreen";
import { ShibaMark } from "./components/ShibaMark";
import { authClient } from "./auth-client";
import { CommandMenu, type CommandItem } from "./components/ui/command-menu";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { useTheme } from "./components/ThemeProvider";
import { Tooltip } from "./components/Tooltip";
import { extractPendingApprovals, extractCompletedDiff, parseRepoName, readPromptParam, runsListUrl, statusChipClass, statusLabel } from "./ui-helpers";
import { createCompletionDrivenPoll, documentVisibilityPause } from "./polling";
import type { AgentPrincipal, RetainedRun, StoredApproval, ToolRunRecord } from "./types";

const ORCHESTRATOR_AGENT = "coding-orchestrator";

// Guard for single-key shortcuts: never fire while the user is typing.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest?.("input, textarea, select, [contenteditable]"));
}

function useRetainedRuns(
  refreshToken: number,
  sessionId: string,
  sessionApiAvailable: boolean,
  fullDetail: boolean,
  enabled: boolean,
): { runs: RetainedRun[]; error: string | null; detailReady: boolean; listSettled: boolean } {
  const [runs, setRuns] = useState<RetainedRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [listSettled, setListSettled] = useState(false);
  // True once a full-payload response has landed while fullDetail was on.
  // Detail surfaces (the diff inspector) gate on it so a summary list can
  // never render as "this run has no diff".
  const [detailReady, setDetailReady] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setListSettled(true);
      return;
    }
    let cancelled = false;
    if (!fullDetail) setDetailReady(false);
    let sessionScoped = sessionApiAvailable;
    let url = runsListUrl(sessionId, sessionScoped, fullDetail);
    const load = async () => {
      try {
        let response = await fetch(url);
        // Backends without session-scoped runs answer 404/405; fall back to the
        // unscoped list rather than leaving the registry empty. A 404 JSON
        // {error:"Session not found."} is different — the session itself is
        // gone, so an unscoped list would show another session's runs.
        if ((response.status === 404 || response.status === 405) && sessionScoped) {
          if (await isSessionNotFoundBody(response)) {
            if (!cancelled) {
              setRuns([]);
              setError(null);
              setDetailReady(fullDetail);
              setListSettled(true);
            }
            return;
          }
          sessionScoped = false;
          url = runsListUrl(sessionId, false, fullDetail);
          response = await fetch(url);
        }
        if (!response.ok) throw new Error(`Runs request failed: ${response.status}`);
        const body = (await response.json()) as { runs?: RetainedRun[] };
        if (!cancelled) {
          setRuns(Array.isArray(body.runs) ? body.runs : []);
          setError(null);
          setDetailReady(fullDetail);
          setListSettled(true);
        }
      } catch (fetchError: unknown) {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : String(fetchError));
          setListSettled(true);
        }
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken, sessionId, sessionApiAvailable, fullDetail, enabled]);

  return { runs, error, detailReady, listSettled };
}

/**
 * Live approval pointers from the orchestrator DO (`GET /api/approvals`).
 * These are the records Slack-card and queued-email approvals write —
 * separate from chat tool-part approvals, and the only surface where a
 * queued email send can be decided. Polls so cards disappear the moment
 * another surface (or a peer) resolves them.
 */
function useStoredApprovals(
  refreshToken: number,
  enabled: boolean,
): {
  approvals: StoredApproval[];
  decided: StoredApproval[];
  error: string | null;
} {
  const [approvals, setApprovals] = useState<StoredApproval[]>([]);
  const [decided, setDecided] = useState<StoredApproval[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // The poll drives DO writes on the backend — only run it while a
    // view that renders the data is up. Re-enabling loads immediately.
    if (!enabled) return;
    let cancelled = false;
    // A slow poll landing after a newer one must not repaint a resolved card.
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      return fetch("/api/approvals")
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
    // Completion-driven fallback (30s): DO state hints bump refreshToken for
    // real-time refreshes; this poll only catches other sessions' approvals.
    // The next tick arms after this load settles (single inflight), and a
    // hidden tab pauses instead of stacking polls.
    const poll = createCompletionDrivenPoll({
      intervalMs: 30_000,
      load,
      pause: documentVisibilityPause(),
    });
    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [refreshToken, enabled]);

  return { approvals, decided, error };
}

// Registered MCP-token principals, polled on the same cadence as stored
// approvals. No error surface: a failed poll just keeps the last list —
// the sidebar Agents group is informational, not a decision surface.
function useAgentPrincipals(refreshToken: number, enabled: boolean): AgentPrincipal[] {
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);

  useEffect(() => {
    // Same gating as the approvals poll — no view rendering this data,
    // no interval; re-entering a view refreshes immediately.
    if (!enabled) return;
    let cancelled = false;
    let sent = 0;
    let applied = 0;
    const load = () => {
      const seq = ++sent;
      return fetch("/api/agents")
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
    const poll = createCompletionDrivenPoll({
      intervalMs: 30_000,
      load,
      pause: documentVisibilityPause(),
    });
    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [refreshToken, enabled]);

  return principals;
}

// A 404 is ambiguous: an older backend answers an unknown route with a bare
// (often non-JSON) 404, while the current Worker answers a real not-found
// with JSON {error:"Session not found."}. Only the JSON signal may be treated
// as a dead session — anything else is a safe "route unsupported" signal.
async function isSessionNotFoundBody(response: Response): Promise<boolean> {
  const body = (await response
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  return body?.error === "Session not found.";
}

type IdentityIssue = "signin" | "unconfigured" | "unreachable" | "error";

/** Static dashboard tests set this. The browser never does, so first paint waits for /api/whoami. */
function testAgentName(): string | null {
  const name = (globalThis as { __shibaTestAgent?: unknown }).__shibaTestAgent;
  return typeof name === "string" && name !== "" ? name : null;
}
type AuthMode = "better-auth" | "access" | "none";
type IdentityResult =
  | { agent: string; auth?: AuthMode }
  | { issue: IdentityIssue; message: string; auth?: AuthMode };

async function fetchIdentity(): Promise<IdentityResult> {
  let res: Response;
  try {
    // manual: Cloudflare Access answers an expired session with a cross-origin
    // login redirect, which would otherwise surface as an opaque CORS failure.
    res = await fetch("/api/whoami", {
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    });
  } catch {
    return { issue: "unreachable", message: "Network error reaching /api/whoami." };
  }
  if (res.type === "opaqueredirect") {
    return { issue: "signin", message: "Sign-in required.", auth: "access" };
  }
  if (res.status === 401) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { code?: unknown } | null;
    if (body?.code === "access_not_configured") {
      return { issue: "unconfigured", message: "Cloudflare Access is not configured." };
    }
    return body?.code === "better_auth"
      ? { issue: "signin", message: "Sign-in required.", auth: "better-auth" }
      : { issue: "signin", message: "Sign-in required." };
  }
  // Non-JSON means something other than the Worker answered (static host, dev proxy).
  const body = (await res.json().catch(() => null)) as { agent?: unknown; auth?: unknown } | null;
  if (
    body === null ||
    res.status === 404 ||
    res.status === 502 ||
    res.status === 503 ||
    res.status === 504
  ) {
    return { issue: "unreachable", message: `GET /api/whoami returned ${res.status}.` };
  }
  if (!res.ok) return { issue: "error", message: `GET /api/whoami failed with ${res.status}.` };
  const auth: AuthMode | undefined =
    body.auth === "better-auth" || body.auth === "access" || body.auth === "none"
      ? body.auth
      : undefined;
  return typeof body.agent === "string" && body.agent !== ""
    ? { agent: body.agent, auth }
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

const VIEW_ALIASES: Record<string, AppNavView> = {
  "run-registry": "analytics",
  orchestrator: "activity",
  mailbox: "inbox",
};

// Each sidebar view owns a root path (/dashboard/, /skills/ …); legacy ?tab=/?view=/?run= still resolve.
function viewFromUrl(): AppNavView | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("run")) return "dashboard";
  const toView = (raw: string | null) => {
    const view = raw ? (VIEW_ALIASES[raw] ?? raw) : null;
    return APP_NAV_ITEMS.some((item) => item.id === view) ? (view as AppNavView) : null;
  };
  return (
    toView(window.location.pathname.split("/")[1] ?? null) ??
    toView(params.get("tab") || params.get("view"))
  );
}

function pathForView(view: MainView): string {
  return view === "tasks" ? "/" : `/${view}/`;
}

const SETUP_TOTAL_STEPS = 6;

const STARTER_TEMPLATES = [
  {
    icon: FlaskConical,
    label: "Fix Failing Tests",
    task: "Investigate test failures in the repository, fix the root cause, and verify all test suites pass with zero regressions.",
  },
  {
    icon: Zap,
    label: "Add Unit Tests",
    task: "Identify uncovered functions in the core modules and add thorough unit test coverage with edge case tests.",
  },
  {
    icon: Sparkles,
    label: "Refactor & Clean",
    task: "Refactor duplicate utility logic, remove unused imports and dead code, and ensure clean types across the codebase.",
  },
  {
    icon: BookOpen,
    label: "Documentation",
    task: "Review and update README and code comments to match recent API changes and architecture decisions.",
  },
];

export function App(): React.JSX.Element {
  const [repoUrl, setRepoUrl] = useState("");
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const savedRepos = useSavedRepos();
  const savedSkills = useSavedSkills();
  const [baseBranch, setBaseBranch] = useState("main");
  // T71 — deep-link ?prompt= prefills empty composer task on app load; replaceState strips it.
  const [task, setTask] = useState(() => {
    const draft = readDraft("default");
    if (typeof window === "undefined") return draft;
    const { prompt, nextSearch } = readPromptParam(window.location.search);
    if (prompt !== null) {
      const nextUrl = window.location.pathname + nextSearch + window.location.hash;
      window.history.replaceState(window.history.state, "", nextUrl);
      if (!draft.trim()) return prompt;
    }
    return draft;
  });
  const [publishPullRequest, setPublishPullRequest] = useState(false);
  const [reviewAfterPublish, setReviewAfterPublish] = useState(true);
  const [runSetup, setRunSetup] = useState(false);
  const [harness, setHarness] = useState("opencode");
  const [customAgentId, setCustomAgentId] = useState("");
  const { agents: customAgentRecords } = useCustomAgentOptions();
  const customAgentPickerOptions = useMemo(
    () =>
      customAgentRecords.map((agent) => ({
        id: agent.id,
        name: agent.config.name,
        slug: agent.slug,
        emoji: agent.config.emoji,
      })),
    [customAgentRecords],
  );
  const [codingModel, setCodingModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ReasoningEffort | "">("");
  const [envVars, setEnvVars] = useState<{ name: string; value: string }[]>([]);
  const [connectionId, setConnectionId] = useState("");
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
  const [mainView, setMainView] = useState<MainView>(() => {
    const view = viewFromUrl();
    return view && view !== "settings" ? view : "tasks";
  });
  // Settings is a Kosuke-style popup, not a full view — every nav path that
  // would land on "settings" opens the modal over the current view instead.
  const [settingsModalOpen, setSettingsModalOpen] = useState(() => viewFromUrl() === "settings");
  // Last section the user had open in the settings modal — reopening lands
  // where they left off; deep links (e.g. the wizard's Models step) override it.
  const [settingsInitialSection, setSettingsInitialSection] = useState<SettingsSectionId>("account");
  const openView = useCallback((view: AppNavView) => {
    // Settings is a popup, not a routable view — every nav path opens the modal.
    if (view === "settings") {
      setSettingsModalOpen(true);
      return;
    }
    setMainView(view);
  }, []);
  // Once visited, the mailbox stays mounted (hidden) — its local state
  // (search text, selected thread, drafts) survives nav switches.
  const [inboxMounted, setInboxMounted] = useState(mainView === "inbox");
  if (mainView === "inbox" && !inboxMounted) setInboxMounted(true);
  const [setupDone, setSetupDone] = useState<number | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string>("default");
  // Per-session composer draft: a scope change loads that scope's draft
  // instead of writing the old text into it; otherwise edits persist after 300 ms idle.
  const draftScope = useRef<string | null>("default");
  const pendingDraft = useRef<{ scope: string; text: string } | null>(null);
  const flushDraft = useCallback(() => {
    const pending = pendingDraft.current;
    pendingDraft.current = null;
    if (pending) writeDraft(pending.scope, pending.text);
  }, []);
  useEffect(() => {
    if (draftScope.current !== selectedSessionId) {
      flushDraft(); // the old scope's unwritten keystrokes land before switching
      draftScope.current = selectedSessionId;
      setTask(readDraft(selectedSessionId));
      return;
    }
    pendingDraft.current = { scope: selectedSessionId, text: task };
    // An emptied composer (submit or clear) flushes now; typing waits for 300 ms idle.
    if (!task.trim()) return flushDraft();
    const timer = window.setTimeout(flushDraft, 300);
    return () => window.clearTimeout(timer);
  }, [selectedSessionId, task, flushDraft]);
  // A failed submit restores its text only into the session it came from.
  const restoreDraft = useCallback((scope: string, text: string) => {
    if (draftScope.current === scope) setTask((current) => (current === "" ? text : current));
    else writeDraft(scope, text);
  }, []);
  // T63 — "Run on: This computer" is offered only while the desktop shell
  // reports a paired, reachable daemon (idle or busy).
  const [runTarget, setRunTarget] = useState<"sandbox" | "local">("sandbox");
  const { status: desktopStatus } = useDesktopStatus();
  const localRunAvailable = desktopStatus?.state === "idle" || desktopStatus?.state === "busy";
  useEffect(() => {
    if (runTarget === "local" && !localRunAvailable) setRunTarget("sandbox");
  }, [runTarget, localRunAvailable]);
  // Only these harnesses run locally; anything else would show as a
  // deployment pin the backend then refuses.
  useEffect(() => {
    if (runTarget === "local" && !["opencode", "claude-code", "codex"].includes(harness))
      setHarness("opencode");
  }, [runTarget, harness]);
  const [sessionApiAvailable, setSessionApiAvailable] = useState(false);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [webSessions, setWebSessions] = useState<
    { id: string; name: string; agentName: string; updatedAt: number }[]
  >([]);
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
      ? localStorage.getItem("shiba:sidebar-collapsed") === "true"
      : false,
  );

  const toggleSessionsCollapsed = useCallback(() => {
    setSessionsCollapsed((current) => {
      const next = !current;
      if (typeof window !== "undefined") {
        try {
          localStorage.setItem("shiba:sidebar-collapsed", String(next));
        } catch {
          // Ignore storage quota or access errors in private mode
        }
      }
      return next;
    });
  }, []);

  // The view itself is read in the useState initializers; only the run pick needs an effect.
  useEffect(() => {
    const runParam = new URLSearchParams(window.location.search).get("run");
    if (runParam) setSelectedRunId(runParam);
  }, []);

  // The first sync rewrites a legacy /app/ URL in place (query kept for any reader); later view changes are history steps.
  const router = useRouter();
  const urlSynced = useRef(false);
  useEffect(() => {
    const path = pathForView(mainView);
    const first = !urlSynced.current;
    urlSynced.current = true;
    if (window.location.pathname === path) return;
    if (first) router.history.replace(path + window.location.search);
    else router.history.push(path);
  }, [mainView, router]);

  useEffect(() => {
    const onPop = () => {
      const view = viewFromUrl();
      if (view === "settings") setSettingsModalOpen(true);
      else {
        setMainView(view ?? "tasks");
        setSettingsModalOpen(false);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const submitFailed = useRef(false);
  const submitInFlight = useRef(false);
  // Same request body => same commandId, so a retried POST dedupes server-side.
  const runCommand = useRef<{ key: string; id: string } | null>(null);
  const clearInFlight = useRef(false);
  const [decisions, setDecisions] = useState<Record<string, boolean>>({});
  const [approvalAnnouncement, setApprovalAnnouncement] = useState("");

  // /api/runs routes by Access identity; the chat socket must use the same
  // DO name or the dashboard would read one identity's runs and chat to another.
  const [orchestratorName, setOrchestratorName] = useState<string | null>(testAgentName);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const [identityIssue, setIdentityIssue] = useState<IdentityIssue | null>(null);
  // Which auth lane proved (or refused) the identity — drives the login
  // surface (better-auth form vs Access reload) and the sign-out control.
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  // Bumping this re-runs the whoami check (retry timer, "Retry now", wake-up).
  const [identityAttempt, setIdentityAttempt] = useState(0);
  const identityFailures = useRef(0);
  const retryIdentity = useCallback(() => setIdentityAttempt((n) => n + 1), []);
  const signedIn = orchestratorName !== null && identityIssue === null;
  const [launchBlocked, setLaunchBlocked] = useState(false);
  useEffect(() => {
    if (!signedIn) {
      setLaunchBlocked(false);
      return;
    }
    let cancelled = false;
    void Promise.all([
      fetch("/api/setup/status", { credentials: "same-origin" }).then((response) =>
        response.ok ? response.json() : null,
      ),
      fetch("/api/providers", { credentials: "same-origin" }).then((response) =>
        response.ok ? response.json() : null,
      ),
    ])
      .then(([setup, providers]) => {
        if (cancelled) return;
        const gateway = Boolean(
          setup && typeof setup === "object" && (setup as { gateway?: { token?: boolean } }).gateway?.token,
        );
        const list =
          providers && typeof providers === "object"
            ? (providers as { providers?: { connection?: { phase?: string } }[] }).providers
            : undefined;
        const connected = Array.isArray(list) && list.some((provider) => provider.connection?.phase === "connected");
        setLaunchBlocked(!gateway && !connected);
      })
      .catch(() => {
        if (!cancelled) setLaunchBlocked(false);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
  // Header setup pill: count deployment-proven steps only after whoami.
  useEffect(() => {
    if (showOnboardingModal || !signedIn) return;
    let cancelled = false;
    detectSetupSteps()
      .then((found) => {
        if (!cancelled) setSetupDone(found.size);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showOnboardingModal, signedIn]);
  // First-run wizard: opens once per browser after the first authenticated
  // session on the better-auth lane (Access identities are operators, not
  // the signup path the wizard serves).
  const [showFirstRun, setShowFirstRun] = useState(false);
  useEffect(() => {
    if (authMode !== "better-auth" || orchestratorName === null) return;
    try {
      if (localStorage.getItem(ONBOARDING_STORAGE_KEY) === "done") return;
    } catch {
      // private mode — show it anyway
    }
    setShowFirstRun(true);
  }, [authMode, orchestratorName]);

  // Better-auth lane sign-out: clears the session cookie, then re-runs
  // whoami — the 401 that follows lands on AuthScreen again.
  const handleSignOut = useCallback(async () => {
    setSettingsModalOpen(false);
    await authClient.signOut().catch(() => {});
    setOrchestratorName(null);
    setAuthMode(null);
    setIdentityIssue("signin");
    retryIdentity();
  }, [retryIdentity]);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    void fetchIdentity().then((result) => {
      if (cancelled) return;
      if ("agent" in result) {
        identityFailures.current = 0;
        setOrchestratorName(result.agent);
        setAuthMode(result.auth ?? null);
        setIdentityError(null);
        setIdentityIssue(null);
        return;
      }
      setIdentityError(result.message);
      setIdentityIssue(result.issue);
      if (result.auth) setAuthMode(result.auth);
      if (result.issue === "signin" || result.issue === "unconfigured") return;
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

  const refreshRuns = useCallback(() => setRefreshToken((token) => token + 1), []);
  // DO state broadcasts hint that runs/approvals changed: trailing 150 ms debounce,
  // at most one refetch per second, and a steady burst still fires within ~1 s.
  const invalidateTimer = useRef<number | undefined>(undefined);
  const invalidateSince = useRef<number | undefined>(undefined);
  const lastInvalidateRefresh = useRef(0);
  const invalidateSoon = useCallback(() => {
    const now = Date.now();
    invalidateSince.current ??= now;
    window.clearTimeout(invalidateTimer.current);
    const due = Math.max(lastInvalidateRefresh.current + 1000, Math.min(now + 150, invalidateSince.current + 1000));
    invalidateTimer.current = window.setTimeout(() => {
      invalidateTimer.current = undefined;
      invalidateSince.current = undefined;
      lastInvalidateRefresh.current = Date.now();
      refreshRuns();
    }, due - now);
  }, [refreshRuns]);
  useEffect(() => () => window.clearTimeout(invalidateTimer.current), []);

  const activeWebSession = webSessions.find((session) => session.id === selectedSessionId);
  const agent = useAgent({
    agent: ORCHESTRATOR_AGENT,
    // Until /api/whoami resolves, don't connect at all — the Worker 403s any
    // name that isn't the caller's identity, so a placeholder DO name just
    // produces a 403 burst on every load.
    name: activeWebSession?.agentName ?? orchestratorName ?? "identity-pending",
    enabled: orchestratorName !== null,
    onStateUpdate: invalidateSoon,
    minReconnectionDelay: 1000,
    maxReconnectionDelay: 30_000,
  });
  useSocketLiveness(agent, orchestratorName !== null, invalidateSoon);
  const chat = useAgentChat({
    agent,
    // Skip the /get-messages prefetch while the DO name is the pending
    // placeholder — it 403s by design. The socket object lags one render
    // behind orchestratorName (it swaps in an effect), so gate on the name
    // the hook actually resolves rather than on orchestratorName alone.
    getInitialMessages: async ({ name, url }) => {
      if (!url || name !== orchestratorName) return [];
      const res = await fetch(`${url}/get-messages`, { credentials: "include" });
      if (!res.ok) return [];
      const text = await res.text();
      if (!text.trim()) return [];
      try {
        return JSON.parse(text);
      } catch {
        return [];
      }
    },
    onError: () => {
      submitFailed.current = true;
    },
  });
  const { runsById } = useAgentToolEvents({ agent });

  useEffect(() => {
    if (!signedIn) {
      setSessionsLoaded(true);
      return;
    }
    let cancelled = false;
    fetch("/api/sessions", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        // Older backends have no sessions API: stay on the implicit default
        // session and use unscoped run routes instead of erroring.
        if (response.status === 404 || response.status === 405) {
          if (!cancelled) setSessionApiAvailable(false);
          return;
        }
        // A signed-out page must not toast a 401. whoami owns the sign-in screen.
        if (response.status === 401) return;
        if (!response.ok) throw new Error(`Sessions request failed: ${response.status}`);
        const body = (await response.json()) as {
          sessions?: { id: string; name: string; agentName: string; updatedAt: number }[];
        };
        if (!cancelled) {
          setSessionApiAvailable(true);
          setWebSessions(Array.isArray(body.sessions) ? body.sessions : []);
          // The mount-time fetch can run pre-auth (e.g. AuthScreen up); once a
          // later attempt succeeds, drop the failure it toasted.
          setNotice((n) => (n?.startsWith("Sessions request failed") ? null : n));
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setSessionsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
  // Ordinary views read the lean summary projection; only the diff
  // inspector pulls the full run payload (diff/receipts/signals/steering).
  const { runs: retainedRuns, error: runsError, detailReady: runsDetailReady, listSettled } =
    useRetainedRuns(
      refreshToken,
      selectedSessionId,
      sessionApiAvailable,
      mainView === "diff",
      signedIn,
    );
  const {
    approvals: storedApprovals,
    decided: decidedStoredApprovals,
    error: storedApprovalsError,
  } = useStoredApprovals(
    refreshToken,
    // Approvals data renders on the approvals board, the tasks strip, and
    // the dashboard decided tail — the nav badge between them refreshes
    // on entry to any of the three.
    signedIn && (mainView === "approvals" || mainView === "tasks" || mainView === "dashboard"),
  );
  const reviewAfterPublishById = useMemo(() => {
    const map: Record<string, boolean> = {};
    for (const approval of storedApprovals) {
      if (approval.reviewAfterPublish) map[approval.approvalId] = true;
    }
    return map;
  }, [storedApprovals]);
  const agentPrincipals = useAgentPrincipals(
    refreshToken,
    signedIn && (mainView === "tasks" || mainView === "dashboard"),
  );

  const toolRuns = useMemo(() => Object.values(runsById) as ToolRunRecord[], [runsById]);

  const pendingApprovals = useMemo(() => extractPendingApprovals(chat.messages), [chat.messages]);

  // A chat-queued approval's DO pointer is the same record — the chat
  // card is the decision surface, so stored pointers already shown as
  // chat cards must not double-render or double-count in badges.
  const visibleStoredApprovals = useMemo(() => {
    const chatIds = new Set(pendingApprovals.map((approval) => approval.approvalId));
    return storedApprovals.filter((approval) => !chatIds.has(approval.approvalId));
  }, [storedApprovals, pendingApprovals]);

  const decidedRef = useRef<Set<string>>(new Set());
  const decidedStoredRef = useRef<Set<string>>(new Set());

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
            approved
              ? "Sandbox execution is now permitted."
              : "No sandbox will start for this tool call."
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
          throw new Error("The approval is gone — it expired or was already decided elsewhere.");
        }
        setApprovalAnnouncement(
          approved ? "Approved — the request is executing." : "Rejected — nothing will execute.",
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
      const branch = baseBranch.trim() || "main";
      const effort =
        reasoningEffort && (HARNESS_REASONING_EFFORTS[harness] ?? []).includes(reasoningEffort)
          ? reasoningEffort
          : "";
      if (runTarget === "local") {
        if (envVars.some((v) => v.name.trim() !== "")) {
          setNotice("Environment variables aren't supported for runs on this computer yet.");
          return;
        }
        if (runSetup) {
          setNotice("Repo setup isn't supported for runs on this computer yet.");
          return;
        }
        setNotice(null);
        // GAP-3 (DESKTOP-PLAN §11.5): submit through POST /api/runs with
        // runtime:"local" — handleRuns stamps the dashboard intake voucher
        // and the approval card appears like any other run. HTTP-only, so the
        // chat-socket identity guards below don't apply. Skills have no
        // /api/runs field and are not sent for local runs.
        const fields = {
          repoUrl: repoUrl.trim(),
          task: task.trim(),
          baseBranch: branch,
          ...(harness ? { harness } : {}),
          ...(codingModel.trim() ? { codingModel: codingModel.trim() } : {}),
          ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
          publishPullRequest,
          ...(publishPullRequest && reviewAfterPublish ? { reviewAfterPublish: true } : {}),
          ...(customAgentId ? { customAgentId } : {}),
        };
        const body = { ...fields, runtime: "local", ...targetMachineFields(desktopStatus) };
        // Keyed on user-editable fields only, so a daemon re-pair doesn't mint a new commandId for a retry.
        const key = JSON.stringify(fields);
        if (runCommand.current?.key !== key) runCommand.current = { key, id: crypto.randomUUID() };
        const commandId = runCommand.current.id;
        const draft = task;
        const draftSession = selectedSessionId;
        setTask("");
        submitInFlight.current = true;
        setIsSubmitting(true);
        try {
          const res = await fetch(
            sessionApiAvailable
              ? `/api/runs?session=${encodeURIComponent(selectedSessionId)}`
              : "/api/runs",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...body, commandId }),
            },
          );
          if (!res.ok) {
            const raw = await res.text().catch(() => "");
            let detail = raw.slice(0, 400);
            try {
              const parsed = JSON.parse(raw) as { error?: string };
              if (typeof parsed.error === "string" && parsed.error.trim()) detail = parsed.error.trim();
            } catch {
              /* plain text */
            }
            throw new Error(detail || `Run request failed with ${res.status}`);
          }
          runCommand.current = null;
          saveRepo(repoUrl.trim());
          setNotice("Queued — approve the run card to execute on this computer.");
          refreshRuns();
        } catch (error) {
          restoreDraft(draftSession, draft);
          setNotice(
            `Run could not be queued: ${error instanceof Error ? error.message : String(error)}`,
          );
        } finally {
          submitInFlight.current = false;
          setIsSubmitting(false);
        }
        return;
      }
      if (!orchestratorName) {
        setNotice(
          identityError
            ? `Task not sent: agent identity failed to resolve (${identityError}).`
            : "Task not sent: still resolving your agent identity.",
        );
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
      let sealedEnv: { sealed: string; names: string[]; digest: string } | null = null;
      const nonBlankEnvVars = envVars.filter((v) => v.name.trim() !== "" || v.value.trim() !== "");
      if (nonBlankEnvVars.some((v) => v.name.trim() !== "")) {
        // Claim the submit before the seal round-trip so a double-click can't queue two runs.
        submitInFlight.current = true;
        setIsSubmitting(true);
        const sealFailed = (message: string) => {
          submitInFlight.current = false;
          setIsSubmitting(false);
          setNotice(message);
        };
        const sealUrl = sessionApiAvailable
          ? `/api/runs/env-seal?session=${encodeURIComponent(selectedSessionId)}`
          : "/api/runs/env-seal";
        try {
          const sealRes = await fetch(sealUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              environmentVariables: nonBlankEnvVars.map((v) => ({
                name: v.name.trim(),
                value: v.value,
              })),
            }),
          });
          const sealData = (await sealRes.json().catch(() => ({}))) as {
            sealed?: string;
            names?: string[];
            digest?: string;
            error?: string;
          };
          if (!sealRes.ok) {
            sealFailed(sealData.error ?? `Failed to seal environment variables (${sealRes.status}).`);
            return;
          }
          if (!sealData.sealed || !sealData.digest || !Array.isArray(sealData.names)) {
            sealFailed("Failed to seal environment variables: invalid server response.");
            return;
          }
          sealedEnv = {
            sealed: sealData.sealed,
            names: sealData.names,
            digest: sealData.digest,
          };
        } catch (sealError) {
          sealFailed(
            `Failed to seal environment variables: ${
              sealError instanceof Error ? sealError.message : String(sealError)
            }`,
          );
          return;
        }
      }
      setNotice(null);
      const attachedSkills = savedSkills.filter((skill) => selectedSkillIds.includes(skill.id));
      const text = [
        `Repository: ${repoUrl.trim()}`,
        `Base branch: ${branch}`,
        `Coding agent harness: ${harness}`,
        ...(codingModel.trim() ? [`Coding model: ${codingModel.trim()}`] : []),
        ...(effort ? [`Reasoning effort: ${effort}`] : []),
        ...(sealedEnv ? [`Environment variables: ${sealedEnv.names.join(", ")}`] : []),
        ...(runSetup ? ["Run repo setup: yes"] : []),
        ...(connectionId.trim() ? [`Model connection: ${connectionId.trim()}`] : []),
        `Open a pull request with the result: ${publishPullRequest ? "yes" : "no"}`,
        ...(publishPullRequest
          ? [`Read-only review after the PR opens: ${reviewAfterPublish ? "yes" : "no"}`]
          : []),
        ...(attachedSkills.length > 0
          ? [
              `Skills: ${attachedSkills.map((skill) => (skill.repoUrl ? `${skill.name} (${skill.repoUrl})` : skill.name)).join(", ")}`,
            ]
          : []),
        "",
        `Task: ${task.trim()}`,
      ].join("\n");
      const draft = task;
      const draftSession = selectedSessionId;
      setTask("");
      submitInFlight.current = true;
      submitFailed.current = false;
      setIsSubmitting(true);
      try {
        // Structured copy of the composer fields so the approval card doesn't
        // depend on the LLM echoing them back from `text`.
        await chat.sendMessage({
          text,
          metadata: {
            shibaTask: {
              repoUrl: repoUrl.trim(),
              task: task.trim(),
              baseBranch: branch,
              harness,
              publishPullRequest,
              ...(publishPullRequest && reviewAfterPublish ? { reviewAfterPublish: true } : {}),
              ...(codingModel.trim() ? { codingModel: codingModel.trim() } : {}),
              ...(connectionId.trim() ? { connectionId: connectionId.trim() } : {}),
              ...(effort ? { reasoningEffort: effort } : {}),
              ...(sealedEnv ? { environment: { sealed: sealedEnv.sealed, digest: sealedEnv.digest } } : {}),
              ...(runSetup ? { runSetup: true } : {}),
              ...(customAgentId ? { customAgentId } : {}),
            },
          },
        });
        // onError already surfaces chat.error in the notice banner.
        if (submitFailed.current) {
          restoreDraft(draftSession, draft);
        } else {
          saveRepo(repoUrl.trim());
          setEnvVars([]);
          refreshRuns();
        }
      } catch (error) {
        restoreDraft(draftSession, draft);
        setNotice(
          `Task could not be sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        submitInFlight.current = false;
        setIsSubmitting(false);
      }
    },
    [
      repoUrl,
      baseBranch,
      task,
      publishPullRequest,
      reviewAfterPublish,
      runSetup,
      harness,
      customAgentId,
      codingModel,
      reasoningEffort,
      envVars,
      connectionId,
      chat,
      agent,
      orchestratorName,
      identityError,
      refreshRuns,
      savedSkills,
      selectedSkillIds,
      runTarget,
      sessionApiAvailable,
      selectedSessionId,
      desktopStatus,
      restoreDraft,
    ],
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
      // Session-scoped delete only when the sessions API exists; never fall
      // back to an unscoped delete for a named session — that would wipe runs
      // belonging to other sessions.
      if (!sessionApiAvailable && selectedSessionId !== "default") {
        setNotice(
          "Conversation history cleared. Run registry is unchanged because this backend does not support session-scoped runs.",
        );
        return;
      }
      const response = await fetch(
        sessionApiAvailable
          ? `/api/runs?session=${encodeURIComponent(selectedSessionId)}`
          : "/api/runs",
        { method: "DELETE" },
      );
      if (sessionApiAvailable && (response.status === 404 || response.status === 405)) {
        // A real "Session not found." means the scoped session is gone — the
        // API still works; prune the stale item and land on the default
        // session instead of disabling session scoping globally.
        if (response.status === 404 && (await isSessionNotFoundBody(response))) {
          setWebSessions((current) =>
            current.filter((session) => session.id !== selectedSessionId),
          );
          setSelectedSessionId("default");
          setNotice(
            "That session no longer exists — it was removed from the list. Conversation history cleared; run registry is unchanged.",
          );
          refreshRuns();
          return;
        }
        setSessionApiAvailable(false);
        setNotice(
          "Conversation history cleared. Run registry is unchanged because this backend does not support session-scoped runs.",
        );
        return;
      }
      if (!response.ok) throw new Error(`Runs clear failed: ${response.status}`);
      setNotice("Conversation history and run registry cleared.");
      refreshRuns();
    } catch (error) {
      setNotice(
        historyCleared
          ? "History cleared locally; run registry could not be cleared"
          : `History could not be cleared: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearInFlight.current = false;
      setClearing(false);
    }
  }, [chat, refreshRuns, selectedSessionId, sessionApiAvailable]);

  const cancelRun = useCallback(
    async (runId: string) => {
      try {
        let url = sessionApiAvailable
          ? `/api/runs/${encodeURIComponent(runId)}?session=${encodeURIComponent(selectedSessionId)}`
          : `/api/runs/${encodeURIComponent(runId)}`;
        let response = await fetch(url, { method: "DELETE" });
        // Scoped delete targets exactly one run; a backend that doesn't know
        // the session route can still cancel it unscoped. But a 404 JSON
        // {error:"Session not found."} means the session itself is gone —
        // prune it and land on the default session instead of disabling the
        // sessions API or firing an unscoped delete at another session's run.
        if ((response.status === 404 || response.status === 405) && sessionApiAvailable) {
          if (response.status === 404 && (await isSessionNotFoundBody(response))) {
            setWebSessions((current) =>
              current.filter((session) => session.id !== selectedSessionId),
            );
            setSelectedSessionId("default");
            setNotice("That session no longer exists — it was removed from the list.");
            refreshRuns();
            return;
          }
          setSessionApiAvailable(false);
          url = `/api/runs/${encodeURIComponent(runId)}`;
          response = await fetch(url, { method: "DELETE" });
        }
        if (!response.ok) throw new Error(`Request failed: ${response.status}`);
        setNotice(`Cancellation requested for ${runId}.`);
        refreshRuns();
      } catch (error) {
        setNotice(
          `Cancellation could not be requested: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [refreshRuns, selectedSessionId, sessionApiAvailable],
  );

  // Keyboard shortcut listener: Cmd/Ctrl+Enter submits, Escape closes modals
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (settingsModalOpen) {
        if ((e.metaKey || e.ctrlKey) && e.key === ",") {
          e.preventDefault();
          setSettingsModalOpen(false);
          return;
        }
        if (
          e.key.toLowerCase() === "d" &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey &&
          !isEditableTarget(e.target)
        ) {
          toggleTheme();
        }
        return;
      }
      if (e.key === "Escape") {
        setShowClearModal(false);
        setShowShortcutsModal(false);
        setShowOnboardingModal(false);
        setMobileSessionsOpen(false);
        setMobileNavOpen(false);
        setCommandMenuOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCommandMenuOpen((prev) => !prev);
        return;
      }
      if (commandMenuOpen || showShortcutsModal || showClearModal || showOnboardingModal || showFirstRun) {
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
      if ((e.key === "j" || e.key === "k") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const list = sessionsNavRef.current;
        if (list.length === 0) return;
        e.preventDefault();
        const currentId = selectedNavIdRef.current;
        const index = list.findIndex((session) => session.id === currentId);
        const delta = e.key === "j" ? 1 : -1;
        const next = list[(index < 0 ? 0 : index + delta + list.length) % list.length];
        if (next) selectSessionRef.current(next.id);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        handleNewTaskRef.current();
      } else if ((e.metaKey || e.ctrlKey) && (e.key === "b" || e.key === "B")) {
        e.preventDefault();
        toggleSessionsCollapsed();
      } else if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsModalOpen(true);
      } else if (e.key.toLowerCase() === "d" && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
  }, [
    isSubmitting,
    repoUrl,
    task,
    submitTask,
    toggleSessionsCollapsed,
    toggleTheme,
    settingsModalOpen,
    commandMenuOpen,
    showShortcutsModal,
    showClearModal,
    showOnboardingModal,
    showFirstRun,
  ]);

  const handleNewTaskRef = useRef<() => void>(() => {});
  const sessionsNavRef = useRef<SessionItem[]>([]);
  const selectedNavIdRef = useRef<string | null>(null);
  const selectSessionRef = useRef<(id: string) => void>(() => {});
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

  const reviewThreadId = useMemo(() => {
    const newest = [...retainedRuns].sort((a, b) => b.updatedAt - a.updatedAt);
    return newest.find((run) => run.pullUrl)?.runId ?? newest[0]?.runId ?? null;
  }, [retainedRuns]);

  const reviewRun = useMemo(() => {
    if (!reviewThreadId) return undefined;
    return retainedRuns.find((run) => run.runId === reviewThreadId);
  }, [retainedRuns, reviewThreadId]);

  const threadHasWork = chat.messages.length > 0 || reviewThreadId !== null;

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
        hasDiff: r.hasDiff ?? Boolean(r.diff),
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
          task:
            typeof input.task === "string" ? input.task : `Delegated run ${tr.runId.slice(0, 8)}`,
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
  // Model-by-purpose config: connections + the coding-purpose suggestion list.
  const modelConfig = useModelConfig();
  const agentsDirectory = useAgentsDirectory();
  const modelConnections = useMemo(
    () =>
      modelConfig.state.kind === "data"
        ? readyConnectionOptions(modelConfig.state.data.connections)
        : [],
    [modelConfig.state],
  );
  // Only offer models the backend would accept: the provider namespace must
  // have a ready connection — and match the selected one when one is picked.
  const codingModelSuggestions = useMemo(() => {
    const models =
      agentsDirectory.state.kind === "data"
        ? agentsDirectory.state.data.agents
            .map((agent) => agent.defaultModel)
            .filter((m) => typeof m === "string" && m.includes("/"))
        : [];
    return codingModelOptions(models, modelConnections, connectionId);
  }, [agentsDirectory.state, modelConnections, connectionId]);

  // Connections/agents can change in Settings — refetch each time the user
  // returns to the composer so the pickers never serve a stale snapshot.
  // Depend on the stable reload callbacks: the hook results are new objects every render, which looped.
  const reloadModelConfig = modelConfig.reload;
  const reloadAgentsDirectory = agentsDirectory.reload;
  useEffect(() => {
    if (mainView === "tasks") {
      reloadModelConfig();
      reloadAgentsDirectory();
    }
  }, [mainView, reloadModelConfig, reloadAgentsDirectory]);

  const repoSuggestions = useMemo(() => {
    const merged = [...savedRepos, ...allRuns.map((run) => run.repoUrl)];
    return [
      ...new Set(
        merged.filter((repo) => typeof repo === "string" && repo.startsWith("https://github.com/")),
      ),
    ];
  }, [savedRepos, allRuns]);

  // Named web sessions are selectable chat contexts; retained delegated runs remain inspectable.
  const sessions = useMemo<SessionItem[]>(() => {
    const items: SessionItem[] = webSessions.map((session) => ({
      id: session.id,
      title:
        session.id === "default" && chat.messages.length > 0 ? "Current session" : session.name,
      repoName: "web chat",
      status:
        session.id === selectedSessionId && (chat.isStreaming || chat.status === "streaming")
          ? "running"
          : launchBlocked
            ? "needs-provider"
            : "ready",
      updatedAt: session.updatedAt,
      live:
        session.id === selectedSessionId &&
        (chat.isStreaming || chat.status === "streaming"),
      webSession: true,
    }));
    if (!items.some((session) => session.id === "default")) {
      items.unshift({
        id: "default",
        title: "Default Session",
        repoName: "web chat",
        status:
          selectedSessionId === "default" && (chat.isStreaming || chat.status === "streaming")
            ? "running"
            : launchBlocked
              ? "needs-provider"
              : "ready",
        updatedAt: 0,
        live:
          selectedSessionId === "default" &&
          (chat.isStreaming || chat.status === "streaming"),
        webSession: true,
      });
    }
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
        title:
          typeof input.task === "string" ? input.task : `Delegated run ${run.runId.slice(0, 8)}`,
        repoName:
          typeof input.repoUrl === "string"
            ? parseRepoName(input.repoUrl)
            : (run.agentType ?? "sandbox"),
        status: run.status,
        updatedAt: seenAt(run.runId),
      });
    }
    return items;
    // Deps are only what the list actually reads — composer keystroke
    // state (task/repoUrl) must not invalidate the sidebar per keypress.
  }, [
    chat.messages.length,
    chat.isStreaming,
    chat.status,
    retainedRuns,
    toolRuns,
    seenAt,
    webSessions,
    selectedSessionId,
    launchBlocked,
  ]);

  const threadsLoading =
    (!sessionsLoaded || !listSettled) && retainedRuns.length === 0 && toolRuns.length === 0;

  const liveSession = sessions.find((session) => session.id === selectedSessionId) ?? sessions[0];

  const handleSelectSession = useCallback(
    async (id: string) => {
      const session = webSessions.find((item) => item.id === id);
      if (!session && id !== "default") {
        // A run row is not a chat session: inspect it without disturbing the
        // selected chat session or its session-scoped run list.
        setSelectedRunId(id);
        setMobileSessionsOpen(false);
        setMainView("analytics");
        return;
      }
      if (session && id !== "default") {
        try {
          const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/resume`, {
            method: "POST",
          });
          if (response.status === 404 || response.status === 405) {
            if (response.status === 404 && (await isSessionNotFoundBody(response))) {
              // Real session-not-found: the API is healthy, this item is stale.
              // Prune it and land on the default session — don't mark the
              // sessions API unavailable or select the dead session.
              setWebSessions((current) => current.filter((item) => item.id !== id));
              setSelectedSessionId("default");
              setMobileSessionsOpen(false);
              setSelectedRunId(null);
              setMainView("tasks");
              setNotice("That session no longer exists — it was removed from the list.");
              return;
            }
            // Older backends lack the resume route: degrade to local selection
            // instead of blocking the switch.
            setSessionApiAvailable(false);
          } else if (!response.ok) {
            throw new Error(`Could not resume session: ${response.status}`);
          }
        } catch (error) {
          setNotice(error instanceof Error ? error.message : String(error));
          return;
        }
      }
      setSelectedSessionId(id);
      setMobileSessionsOpen(false);
      setSelectedRunId(null);
      setMainView("tasks");
    },
    [webSessions],
  );

  sessionsNavRef.current = sessions;
  selectedNavIdRef.current = selectedRunId ?? selectedSessionId;
  selectSessionRef.current = (id: string) => {
    void handleSelectSession(id);
  };

  const handleNewTask = useCallback(async () => {
    if (!sessionApiAvailable) {
      setSelectedSessionId("default");
      setMobileSessionsOpen(false);
      setMainView("tasks");
      window.setTimeout(
        () =>
          document
            .querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')
            ?.focus(),
        0,
      );
      return;
    }
    try {
      const response = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (response.status === 404 || response.status === 405) {
        setSessionApiAvailable(false);
        setSelectedSessionId("default");
        setMobileSessionsOpen(false);
        setMainView("tasks");
        window.setTimeout(
          () =>
            document
              .querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')
              ?.focus(),
          0,
        );
        return;
      }
      if (!response.ok) throw new Error(`Could not create session: ${response.status}`);
      const body = (await response.json()) as {
        session: { id: string; name: string; agentName: string; updatedAt: number };
      };
      setWebSessions((current) => [
        body.session,
        ...current.filter((session) => session.id !== body.session.id),
      ]);
      setSelectedSessionId(body.session.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
    setMobileSessionsOpen(false);
    setMainView("tasks");
    window.setTimeout(() => {
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')
        ?.focus();
    }, 0);
  }, [sessionApiAvailable]);

  const activeSandboxCount = useMemo(() => {
    return (
      toolRuns.filter((r) => r.status === "running" || r.status === "pending").length +
      retainedRuns.filter((r) => r.status === "running" || r.status === "pending").length
    );
  }, [toolRuns, retainedRuns]);

  const connectionState = identityError
    ? `Identity error: ${identityError}`
    : agent.connectionError
      ? `Connection error: ${agent.connectionError.message ?? "unknown"}`
      : launchBlocked
        ? "Can't launch yet"
        : agent.identified
          ? "Connected"
          : "Connecting";

  const busy =
    isSubmitting ||
    clearing ||
    chat.isStreaming ||
    chat.status === "streaming" ||
    chat.status === "submitted";

  const commands: CommandItem[] = [
    ...APP_NAV_ITEMS.map((item) => ({
      id: `nav-${item.id}`,
      label: `Go to ${item.label}`,
      hint: item.description,
      run: () => openView(item.id),
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
      run: () => setShowFirstRun(true),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      hint: "?",
      run: () => setShowShortcutsModal(true),
    },
  ];

  if (orchestratorName === null && identityIssue === null) {
    return <SessionPending />;
  }

  // Built-in login lane: the Worker 401s with code "better-auth".
  if (identityIssue === "signin" && authMode === "better-auth") {
    return <AuthScreen onSignedIn={retryIdentity} />;
  }

  if (identityIssue === "signin" || identityIssue === "unconfigured") {
    const accessUnconfigured = identityIssue === "unconfigured";
    return (
      <div className="h-dvh bg-[var(--bg)] text-[var(--fg)] font-sans flex items-center justify-center p-6 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]">
        <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-sm w-full p-6 shadow-[var(--sh-overlay)] flex flex-col items-center text-center gap-3">
          <ShibaMark />
          <h1 className="text-xl text-[var(--fg)]">
            {accessUnconfigured ? "Dashboard access isn't configured" : "Sign in to continue"}
          </h1>
          <p className="text-sm text-[var(--muted-foreground-2)] leading-relaxed">
            {accessUnconfigured
              ? "This deployment has no Cloudflare Access application, so the dashboard is locked. Set ACCESS_EMAILS and WORKERS_SUBDOMAIN and redeploy, or set ACCESS_AUD to an existing Access app's AUD tag."
              : "Your Cloudflare Access session has expired or you are not signed in yet."}
          </p>
          {accessUnconfigured ? (
            <a
              href="/docs/deployment/"
              className="mt-1 w-full min-h-11 flex items-center justify-center rounded-[var(--radius-button)] bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] text-white text-sm font-semibold transition-colors shadow-[var(--sh-card)]"
            >
              Deployment documentation
            </a>
          ) : (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-1 w-full min-h-11 rounded-[var(--radius-button)] bg-[var(--primary)] hover:bg-[var(--primary-soft-hover)] text-white text-sm font-semibold transition-colors shadow-[var(--sh-card)] active:scale-[0.98]"
            >
              Sign in
            </button>
          )}
        </div>
      </div>
    );
  }

  if (identityIssue === "unreachable" || identityIssue === "error") {
    return (
      <SessionProblem
        message={
          identityIssue === "unreachable"
            ? "Backend not connected — open your Worker URL."
            : `Identity lookup failed: ${identityError ?? "unknown error"}`
        }
        onRetry={retryIdentity}
      />
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
    <div className="h-dvh overflow-hidden bg-[var(--bg)] text-[var(--fg)] font-sans selection:bg-[var(--primary)] selection:text-[var(--primary-text)] flex pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* LEFT: app navigation rail (lg+; phones use the sheet below) */}
      <AppNavRail
        collapsed={sessionsCollapsed}
        activeView={mainView}
        onNavigate={openView}
        pendingApprovalCount={pendingApprovals.length + visibleStoredApprovals.length}
        theme={theme}
        onToggleTheme={toggleTheme}
        activeSandboxCount={activeSandboxCount}
        setupDone={setupDone}
        setupTotal={SETUP_TOTAL_STEPS}
        onOpenSetup={() => setShowFirstRun(true)}
        onOpenShortcuts={() => setShowShortcutsModal(true)}
        accountEmail={orchestratorName}
        onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
        sessions={sessions}
        selectedSessionId={selectedRunId ?? selectedSessionId}
        onSelectSession={handleSelectSession}
        onNewTask={handleNewTask}
        onOpenSearch={() => setCommandMenuOpen(true)}
        onToggleCollapse={toggleSessionsCollapsed}
        threadsLoading={threadsLoading}
        connectionLabel={connectionState}
        connectionTone={
          identityError || agent.connectionError
            ? "error"
            : launchBlocked || !agent.identified
              ? "pending"
              : "ok"
        }
      />

      {mobileNavOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            className="absolute inset-0 bg-[var(--overlay)]"
            onClick={() => setMobileNavOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 shadow-[var(--sh-overlay)] animate-enter-x">
            <AppNavRail
              variant="sheet"
              activeView={mainView}
              onNavigate={(view) => {
                if (view === "settings") mobileNavWasOpen.current = false;
                openView(view);
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
                setShowFirstRun(true);
              }}
              onOpenShortcuts={() => {
                setMobileNavOpen(false);
                setShowShortcutsModal(true);
              }}
              accountEmail={orchestratorName}
              onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
              onClose={() => setMobileNavOpen(false)}
              sessions={sessions}
              selectedSessionId={selectedRunId ?? selectedSessionId}
              onSelectSession={(id) => {
                handleSelectSession(id);
                setMobileNavOpen(false);
              }}
              onNewTask={() => {
                handleNewTask();
                setMobileNavOpen(false);
              }}
              threadsLoading={threadsLoading}
              onOpenSearch={() => {
                setMobileNavOpen(false);
                setCommandMenuOpen(true);
              }}
              connectionLabel={connectionState}
              connectionTone={
                identityError || agent.connectionError
                  ? "error"
                  : launchBlocked || !agent.identified
                    ? "pending"
                    : "ok"
              }
            />
          </div>
        </div>
      ) : null}

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* TOP BAR — subtle chrome header */}
        <header className="h-[calc(2.5rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] shrink-0 bg-[var(--chrome)] border-b border-[var(--border-1)] text-[var(--fg)] flex items-center gap-2.5 pl-2 pr-3 lg:px-4 z-20">
          <button
            type="button"
            ref={mobileNavTriggerRef}
            onClick={() => setMobileNavOpen(true)}
            aria-label="Open navigation"
            aria-expanded={mobileNavOpen}
            className="lg:hidden size-9 -my-1 shrink-0 rounded-[var(--radius-button)] flex items-center justify-center text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] transition-colors"
          >
            <svg
              aria-hidden="true"
              className="size-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
              Shiba
            </span>
            <span className="text-[var(--muted-foreground-3)] text-xs" aria-hidden="true">
              /
            </span>
            <span className="text-[13px] font-medium text-[var(--fg)] truncate">
              {APP_NAV_ITEMS.find((item) => item.id === mainView)?.label ?? "Threads"}
            </span>
          </nav>
          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip content="Command menu" shortcut="⌘K" side="bottom">
              <button
                type="button"
                onClick={() => setCommandMenuOpen(true)}
                aria-label="Open command menu"
                className="h-7 touch:h-8 touch:min-w-10 justify-center rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] flex items-center gap-1.5 px-2 text-[11px] font-medium transition-colors"
              >
                <svg
                  aria-hidden="true"
                  className="size-3.5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
                  />
                </svg>
                <span className="font-mono text-[10px] text-[var(--muted-foreground-2)]">⌘K</span>
              </button>
            </Tooltip>
          </div>
        </header>

        {bannerMessage ? (
          <div
            role="alert"
            className="shrink-0 flex items-center gap-3 px-4 py-2 bg-[var(--destructive-soft)] border-b border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] text-xs text-[var(--destructive)]"
          >
            <span
              className="size-2 shrink-0 rounded-full bg-[var(--destructive)] animate-pulse"
              aria-hidden="true"
            />
            <span className="flex-1 min-w-0 break-words">
              {bannerMessage}
              {online && identityIssue ? (
                <span className="text-[var(--muted-foreground-2)]"> Retrying automatically.</span>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => {
                if (identityIssue) retryIdentity();
                else agent.reconnect();
              }}
              className="shrink-0 touch:min-h-11 px-3 py-1 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_40%,transparent)] bg-[var(--card)] text-[var(--destructive)] font-medium hover:bg-[var(--destructive-soft)] transition-colors"
            >
              Retry now
            </button>
          </div>
        ) : null}

        <div className="flex-1 flex min-w-0 min-h-0">
          {inboxMounted ? (
            <div
              className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]"
              style={mainView === "inbox" ? undefined : { display: "none" }}
            >
              <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--fg)] flex items-center gap-2">
                    <span>Mailbox</span>
                  </h2>
                  <p className="text-xs text-[var(--muted-foreground-2)]">
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
          ) : null}
          {mainView === "inbox" ? null : mainView === "dashboard" ? (
            <DashboardView
              runs={retainedRuns}
              pendingApprovals={pendingApprovals}
              storedApprovals={visibleStoredApprovals}
              agents={agentPrincipals}
              launchBlocked={launchBlocked}
              connectionLabel={connectionState}
              connectionTone={
                identityError || agent.connectionError
                  ? "error"
                  : launchBlocked || !agent.identified
                    ? "pending"
                    : "ok"
              }
              runsError={runsError}
              onNavigate={openView}
              onNewTask={handleNewTask}
              onInspectRun={(runId) => {
                setSelectedRunId(runId);
                setMainView("analytics");
              }}
            />
          ) : mainView === "tasks" ? (
            <div className="flex-1 flex overflow-hidden">
              {/* Mobile sessions drawer (below lg) */}
              {mobileSessionsOpen ? (
                <div className="fixed inset-0 z-40 lg:hidden">
                  <button
                    type="button"
                    aria-label="Close sessions"
                    className="absolute inset-0 bg-[var(--overlay)]"
                    onClick={() => setMobileSessionsOpen(false)}
                  />
                  <div className="absolute inset-y-0 left-0 shadow-[var(--sh-overlay)] bg-[var(--bg)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] animate-enter-x">
                    <SessionsSidebar
                      sessions={sessions}
                      agents={agentPrincipals}
                      selectedId={selectedRunId ?? selectedSessionId}
                      onSelect={handleSelectSession}
                      onNewTask={handleNewTask}
                      connectionLabel={connectionState}
                      connectionTone={
                        identityError || agent.connectionError
                          ? "error"
                          : launchBlocked || !agent.identified
                            ? "pending"
                            : "ok"
                      }
                      setupDone={setupDone}
                      setupTotal={SETUP_TOTAL_STEPS}
                      onOpenSetup={() => {
                        setMobileSessionsOpen(false);
                        setShowFirstRun(true);
                      }}
                      isMobileDrawer={true}
                      onToggleCollapse={() => setMobileSessionsOpen(false)}
                    />
                  </div>
                </div>
              ) : null}

              {/* CENTER: conversation timeline + composer */}
              <main
                className="flex-1 flex flex-col min-w-0 overflow-hidden bg-[var(--bg)]"
                aria-busy={busy}
              >
                {/* SESSION HEADER */}
                <div className="border-b border-[var(--border-1)] bg-[var(--card)]/60 px-3 sm:px-5 xl:px-6 py-2.5 flex items-center justify-between gap-3 shrink-0">
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
                        className="hidden lg:flex w-7 h-7 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] items-center justify-center transition-colors shrink-0"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          {sessionsCollapsed ? (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M13 5l7 7-7 7M5 5l7 7-7 7"
                            />
                          ) : (
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={1.8}
                              d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                            />
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
                        className="lg:hidden w-7 h-7 touch:w-11 touch:h-11 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] text-[var(--muted-foreground-2)] hover:text-[var(--fg)] flex items-center justify-center transition-colors shrink-0"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                      </button>
                    </Tooltip>

                    <Tooltip content="Shiba Coding Agent" side="bottom">
                      <img
                        src="/assets/mascot/pet-logo.png"
                        alt="Shiba"
                        className="w-6 h-6 rounded-full bg-white object-contain border border-[var(--primary)]/40 shrink-0 cursor-default"
                      />
                    </Tooltip>
                    <h1 className="text-base text-[var(--fg)] tracking-tight truncate">
                      {liveSession ? liveSession.title : "New coding task"}
                    </h1>
                    <span
                      className={`text-[10px] font-mono font-bold uppercase tracking-wider border px-2 py-0.5 shrink-0 ${statusChipClass(liveSession?.status ?? "ready")}`}
                    >
                      {statusLabel(liveSession?.status ?? "ready")}
                    </span>
                  </div>

                  <div className="hidden md:flex items-center gap-4 text-xs font-mono text-[var(--muted-foreground-2)] shrink-0">
                    <Tooltip content="Tool runs currently in flight" side="bottom">
                      <span className="cursor-default">
                        <span className="text-[var(--muted-foreground-2)]">Active</span>{" "}
                        <span className="text-[var(--primary)] font-bold">{toolRuns.length}</span>
                      </span>
                    </Tooltip>
                    <Tooltip content="Actions waiting for human approval" side="bottom">
                      <span className="cursor-default">
                        <span className="text-[var(--muted-foreground-2)]">Approvals</span>{" "}
                        <span
                          className={
                            pendingApprovals.length + visibleStoredApprovals.length > 0
                              ? "font-bold text-[var(--warning-fg)]"
                              : "font-bold text-[var(--muted-foreground-2)]"
                          }
                        >
                          {pendingApprovals.length + visibleStoredApprovals.length}
                        </span>
                      </span>
                    </Tooltip>
                    <Tooltip content="Retained runs in this workspace" side="bottom">
                      <span className="cursor-default">
                        <span className="text-[var(--muted-foreground-2)]">Runs</span>{" "}
                        <span className="text-[var(--fg)] font-bold">{allRuns.length}</span>
                      </span>
                    </Tooltip>
                  </div>
                </div>

                {/* PENDING APPROVALS STRIP */}
                {pendingApprovals.length + visibleStoredApprovals.length > 0 ||
                approvalAnnouncement ? (
                  <div className="bg-[var(--card)] border-b border-[var(--border-1)] px-3 sm:px-5 xl:px-6 py-3 flex items-center justify-between gap-3 shadow-[var(--sh-card)] z-10 shrink-0">
                    <p
                      className="text-sm font-medium text-[var(--fg)]"
                      role="status"
                      aria-live="polite"
                    >
                      {pendingApprovals.length + visibleStoredApprovals.length > 0 ? (
                        <span className="flex items-center gap-2 text-[var(--warning-fg)]">
                          <span className="w-2.5 h-2.5 rounded-full bg-[var(--warning-fg)] animate-pulse" />
                          {pendingApprovals.length + visibleStoredApprovals.length} task
                          {pendingApprovals.length + visibleStoredApprovals.length === 1 ? "" : "s"}{" "}
                          waiting for your approval.
                        </span>
                      ) : (
                        <span className="text-[var(--success)] flex items-center gap-2">
                          <svg
                            aria-hidden="true"
                            className="w-4 h-4"
                            fill="none"
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M5 13l4 4L19 7"
                            />
                          </svg>
                          {approvalAnnouncement}
                        </span>
                      )}
                    </p>
                    {visibleStoredApprovals.length > 0 ? (
                      <button
                        type="button"
                        onClick={() => setMainView("approvals")}
                        className="shrink-0 text-xs font-semibold text-[var(--warning-fg)] border border-[color-mix(in_oklch,var(--warning-fg)_40%,transparent)] bg-[color-mix(in_oklch,var(--warning-fg)_10%,transparent)] hover:bg-[var(--warning-fg)]/15 rounded-[var(--radius-button)] px-3 py-1.5 touch:min-h-11 transition-colors"
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
                      <div
                        role="status"
                        aria-live="polite"
                        className="text-xs text-[var(--muted-foreground-2)] bg-[var(--card)] p-3 rounded-[var(--radius-button)] border border-[var(--border-1)] flex items-start gap-2"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4 text-[var(--primary)] shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <div className="break-words">{notice}</div>
                      </div>
                    ) : null}
                    {chat.error ? (
                      <div
                        role="alert"
                        className="text-xs text-[var(--destructive)] bg-[var(--destructive-soft)] p-3 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] flex items-start gap-2"
                      >
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4 text-[var(--destructive)] shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                          />
                        </svg>
                        <div className="break-words">Chat error: {chat.error.message}</div>
                      </div>
                    ) : null}
                    {runsError ? (
                      <div className="text-xs text-[var(--destructive)] bg-[var(--destructive-soft)] p-3 rounded-[var(--radius-button)] border border-[color-mix(in_oklch,var(--destructive)_30%,transparent)] flex items-start gap-2">
                        <svg
                          aria-hidden="true"
                          className="w-4 h-4 text-[var(--destructive)] shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                          />
                        </svg>
                        <div className="break-words">Runs registry: {runsError}</div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* TIMELINE (scrollable) — hidden on the empty-state hero */}
                <div
                  className={`flex-1 overflow-y-auto overscroll-contain px-3 sm:px-5 xl:px-8 py-5 ${threadHasWork ? "" : "hidden"}`}
                >
                  {chat.messages.length > 0 ? (
                    <StepTimeline
                      messages={chat.messages}
                      isStreaming={chat.isStreaming || chat.status === "streaming"}
                      pendingApprovals={pendingApprovals}
                      decisions={decisions}
                      onDecideApproval={decideApproval}
                      reviewAfterPublishById={reviewAfterPublishById}
                      starters={STARTER_TEMPLATES}
                      onStarter={(starterTask) => {
                        setTask(starterTask);
                        if (!repoUrl) setRepoUrl("https://github.com/cloudflare/ai-chat");
                      }}
                    />
                  ) : null}
                  {reviewThreadId ? (
                    <div className="mt-4 flex flex-col gap-3">
                      <RunProgressCard run={reviewRun} />
                      <RunUsageCard runs={retainedRuns} />
                      <PullRequestCard
                        threadId={reviewThreadId}
                        fallbackPullUrl={reviewRun?.pullUrl}
                        publishRequested={reviewRun?.publishPullRequest === true}
                      />
                      <ReviewFindings
                        threadId={reviewThreadId}
                        reviewAfterPublish={reviewRun?.reviewAfterPublish === true}
                      />
                    </div>
                  ) : null}
                </div>

                {/* COMPOSER — hero when the session is empty, docked once the run is going */}
                <div
                  className={
                    chat.messages.length === 0 && !reviewThreadId
                      ? "flex-1 flex flex-col min-h-0"
                      : "border-t border-[var(--border-1)] bg-[var(--card)]/60 px-3 sm:px-5 xl:px-8 pt-3 sm:pt-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:pb-[max(1rem,env(safe-area-inset-bottom))] shrink-0"
                  }
                >
                  <TaskComposer
                    repoUrl={repoUrl}
                    task={task}
                    baseBranch={baseBranch}
                    publishPullRequest={publishPullRequest}
                    reviewAfterPublish={reviewAfterPublish}
                    harness={harness}
                    busy={busy}
                    repoSuggestions={repoSuggestions}
                    skills={savedSkills}
                    selectedSkillIds={selectedSkillIds}
                    onToggleSkill={(id) =>
                      setSelectedSkillIds((current) =>
                        current.includes(id)
                          ? current.filter((entry) => entry !== id)
                          : [...current, id],
                      )
                    }
                    isSubmitting={isSubmitting}
                    clearing={clearing}
                    runTarget={runTarget}
                    onRunTargetChange={setRunTarget}
                    localRunAvailable={localRunAvailable}
                    onRepoUrlChange={setRepoUrl}
                    onTaskChange={setTask}
                    onBaseBranchChange={setBaseBranch}
                    onPublishPullRequestChange={(value) => {
                      setPublishPullRequest(value);
                      if (value) setReviewAfterPublish(true);
                    }}
                    onReviewAfterPublishChange={setReviewAfterPublish}
                    runSetup={runSetup}
                    onRunSetupChange={setRunSetup}
                    onHarnessChange={setHarness}
                    customAgents={customAgentPickerOptions}
                    customAgentId={customAgentId}
                    onCustomAgentChange={setCustomAgentId}
                    routing={{
                      codingModel,
                      connectionId,
                      onCodingModelChange: setCodingModel,
                      onConnectionChange: setConnectionId,
                      reasoningEffort,
                      onReasoningEffortChange: setReasoningEffort,
                      modelSuggestions: codingModelSuggestions,
                      connections: modelConnections,
                    }}
                    envVars={envVars}
                    onEnvVarsChange={setEnvVars}
                    variant={threadHasWork ? "docked" : "hero"}
                    onSubmit={submitTask}
                    onClear={() => setShowClearModal(true)}
                  />
                </div>
              </main>
            </div>
          ) : mainView === "activity" ? (
            // Remount on session switch so the previous session's spine never
            // renders as the new one's while its first fetch is in flight.
            <div className="flex-1 overflow-y-auto">
              <ActivityReportView
                key={selectedSessionId}
                sessionId={selectedSessionId}
                sessionApiAvailable={sessionApiAvailable}
              />
              <div className="flex h-[max(520px,70vh)] flex-col">
                <ActivityView
                  key={selectedSessionId}
                  sessionId={selectedSessionId}
                  sessionApiAvailable={sessionApiAvailable}
                />
              </div>
            </div>
          ) : mainView === "analytics" ? (
            <AnalyticsView
              runs={retainedRuns}
              error={runsError}
              sessionId={selectedSessionId}
              sessionApiAvailable={sessionApiAvailable}
              onNavigate={openView}
            />
          ) : mainView === "diff" ? (
            <DiffView
              runs={allRuns}
              selectedRunId={
                selectedRunId ??
                (allRuns.some((run) => run.runId === selectedSessionId) ? selectedSessionId : null)
              }
              onSelectRun={(id) => setSelectedRunId(id)}
              loading={!runsDetailReady}
              error={runsError}
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
              reviewAfterPublishById={reviewAfterPublishById}
            />
          ) : mainView === "memory" ? (
            <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--bg)] text-[var(--fg)]">
              <div className="border-b border-[var(--border-1)] bg-[var(--panel)] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-semibold text-[var(--fg)] flex items-center gap-2">
                    <span>Agent Memory</span>
                  </h2>
                  <p className="text-xs text-[var(--muted-foreground-2)]">
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
          ) : mainView === "swarm" ? (
            <SwarmDeskView
              runs={retainedRuns}
              onResolve={async (runId) => {
                const params = new URLSearchParams();
                if (selectedSessionId) params.set("session", selectedSessionId);
                const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/archive?${params}`, { method: "POST" });
                if (!response.ok) {
                  const body = await response.json().catch(() => ({})) as { error?: string };
                  throw new Error(body.error ?? `Resolve failed (${response.status}).`);
                }
                refreshRuns();
              }}
              onApplyIntake={(prompt) => {
                setTask(prompt);
                setMainView("tasks");
                window.setTimeout(() => {
                  document.querySelector<HTMLTextAreaElement>('[data-testid="task-composer"] textarea')?.focus();
                }, 0);
              }}
              shareUrlFor={async (runId) => {
                const response = await fetch("/api/swarm/share", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ runId }),
                });
                const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
                if (!response.ok || typeof body.url !== "string") {
                  throw new Error(body.error ?? `Share failed (${response.status}).`);
                }
                return body.url;
              }}
            />
          ) : mainView === "providers" ? (
            <ProvidersView />
          ) : mainView === "skills" ? (
            <SkillsView />
          ) : mainView === "custom-agents" ? (
            <CustomAgentsView />
          ) : mainView === "agents" ? (
            <AgentsView />
          ) : mainView === "integrations" ? (
            <IntegrationsView onNavigate={openView} />
          ) : mainView === "remote" ? (
            <RemoteAccessView />
          ) : null}

          {/* SETTINGS — Kosuke-style popup over the current view */}
          {settingsModalOpen ? (
            <SettingsModal
              isOpen
              initialSection={settingsInitialSection}
              onSectionChange={setSettingsInitialSection}
              onClose={() => setSettingsModalOpen(false)}
              onFocusRestore={() => {
                if (window.matchMedia("(max-width: 1023px)").matches) {
                  mobileNavTriggerRef.current?.focus();
                }
              }}
              onOpenSessions={() => {
                setMainView("tasks");
                if (window.matchMedia("(min-width: 1024px)").matches) {
                  setSessionsCollapsed((collapsed) => {
                    if (collapsed) {
                      try {
                        localStorage.setItem("shiba:sidebar-collapsed", "false");
                      } catch {
                        // Ignore storage errors in private mode.
                      }
                    }
                    return false;
                  });
                } else {
                  setMobileSessionsOpen(true);
                }
              }}
              onNavigate={(view) => {
                setSettingsModalOpen(false);
                openView(view);
              }}
              onSignOut={authMode === "better-auth" ? handleSignOut : undefined}
            />
          ) : null}

          {/* CLEAR HISTORY CONFIRMATION MODAL */}
          {showClearModal ? (
            <div className="fixed inset-0 bg-[var(--overlay)] z-50 flex items-center justify-center p-4">
              <div className="bg-[var(--card)] border border-[var(--border-1)] rounded-[var(--radius-button)] max-w-md w-full p-6 shadow-[var(--sh-overlay)]">
                <h3 className="text-lg font-bold text-[var(--fg)] mb-2">
                  Clear Conversation & Runs?
                </h3>
                <p className="text-sm text-[var(--muted-foreground-2)] mb-5 leading-relaxed">
                  This will erase all active conversation history and delete retained run registry
                  records on the orchestrator. Active sandboxes will not be destroyed automatically.
                </p>
                <div className="flex items-center justify-end gap-3">
                  <button
                    type="button"
                    className="px-4 py-2 rounded-[var(--radius-button)] text-sm font-medium text-[var(--muted-foreground-2)] hover:text-[var(--fg)] bg-[var(--card)] border border-[var(--border-1)] transition-colors"
                    onClick={() => setShowClearModal(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="px-4 py-2 rounded-[var(--radius-button)] text-sm font-semibold text-white bg-[var(--destructive)] hover:bg-[var(--destructive)]/90 transition-colors shadow-[var(--sh-card)]"
                    onClick={confirmClearAll}
                  >
                    Yes, Clear History
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* ONBOARDING SETUP MODAL */}
          <FirstRunWizard
            open={showFirstRun}
            onClose={() => setShowFirstRun(false)}
            onNavigate={openView}
            onOpenModels={() => {
              setSettingsInitialSection("models");
              setSettingsModalOpen(true);
            }}
            onOpenChecklist={() => setShowOnboardingModal(true)}
          />

          <OnboardingModal
            isOpen={showOnboardingModal}
            onClose={() => setShowOnboardingModal(false)}
            onOpenInbox={() => setMainView("inbox")}
            onSelectStarterTask={(repo, t, h) => {
              setRepoUrl(repo);
              setTask(t);
              setHarness(h);
            }}
          />

          <ShortcutsDialog open={showShortcutsModal} onClose={() => setShowShortcutsModal(false)} />
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
