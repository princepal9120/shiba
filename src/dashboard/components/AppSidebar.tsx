/**
 * AppSidebar — unified left sidebar (248px, all views).
 * Linear/Hoplite-style: workspace header, search, primary "New task"
 * button, icon+label nav, sessions list, utility footer. Collapses to a
 * 56px icon rail so navigation stays reachable. See DESIGN.md.
 */
import { useMemo, useState, type JSX } from "react";
import { formatTimeAgo, statusLabel } from "../ui-helpers";
import { Tooltip } from "./Tooltip";

export type AppNavView =
  | "tasks"
  | "vm"
  | "runs"
  | "agents"
  | "automations"
  | "missions"
  | "gates"
  | "architecture";

export interface AppNavItem {
  id: AppNavView;
  label: string;
  description: string;
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  { id: "tasks", label: "Tasks", description: "Tasks & Live Sessions" },
  { id: "vm", label: "VM", description: "VM Inspector & Terminals" },
  { id: "runs", label: "Runs", description: "Run Registry & Workspaces" },
  { id: "agents", label: "Agents", description: "Agent CLIs in the Sandbox Image" },
  { id: "automations", label: "Automations", description: "Automations & Triggers" },
  { id: "missions", label: "Missions", description: "Missions & Standing Goals" },
  { id: "gates", label: "Gates", description: "Review, QA & Security Gates" },
  { id: "architecture", label: "Architecture", description: "System Architecture & Isolation" },
];

export interface SessionItem {
  id: string; // runId, or "live" for the active chat session
  title: string; // task text (truncate display, not data)
  repoName: string; // parseRepoName(repoUrl)
  status: string; // pending|running|completed|error|aborted|cancelled|waiting-approval|live
  updatedAt: number;
  live?: boolean;
}

export interface AppSidebarProps {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  isMobileDrawer?: boolean;
  sessions: SessionItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  connectionLabel: string;
  connectionTone: "ok" | "pending" | "error";
  activeSandboxCount: number;
  setupDone: number | null;
  setupTotal: number;
  onOpenSetup: () => void;
  onOpenShortcuts: () => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
}

const ICONS: Record<AppNavView, JSX.Element> = {
  tasks: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  vm: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l6-6-6-6M12 19h8" />
    </svg>
  ),
  runs: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.14v14l11-7-11-7z" />
    </svg>
  ),
  agents: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  ),
  automations: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  missions: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />
    </svg>
  ),
  gates: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  architecture: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
    </svg>
  ),
};

function statusDotClass(session: SessionItem): string {
  if (session.live || session.status === "live" || session.status === "running") {
    return "bg-[#2dd4bf]";
  }
  if (session.status === "waiting-approval" || session.status === "pending") {
    return "bg-[#d9a13b]";
  }
  if (session.status === "completed") {
    return "bg-[#4cc38a]";
  }
  if (
    session.status === "error" ||
    session.status === "aborted" ||
    session.status === "cancelled"
  ) {
    return "bg-[#f06666]";
  }
  return "bg-zinc-500";
}

function connectionDotClass(tone: AppSidebarProps["connectionTone"]): string {
  if (tone === "ok") return "bg-[#4cc38a]";
  if (tone === "pending") return "bg-[#d9a13b] animate-pulse-subtle";
  return "bg-[#f06666]";
}

function GroupLabel({ children }: { children: string }) {
  return (
    <h3 className="px-2 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500 select-none">
      {children}
    </h3>
  );
}

function SessionRow({
  session,
  selected,
  onSelect,
}: {
  session: SessionItem;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const tooltipText = `${session.title || "Untitled session"} (${session.repoName} · ${statusLabel(session.status)})`;

  return (
    <Tooltip content={tooltipText} side="right" align="start" delayMs={400}>
      <button
        type="button"
        onClick={() => onSelect(session.id)}
        aria-current={selected ? "true" : undefined}
        className={`group w-full text-left rounded-md px-2 py-1.5 flex items-start gap-2 transition-colors ${
          selected ? "bg-white/[0.07] text-zinc-100" : "hover:bg-white/[0.04] text-zinc-300"
        }`}
      >
        <span
          className={`mt-[7px] size-1.5 rounded-full shrink-0 ${statusDotClass(session)}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block text-[13px] truncate leading-snug ${
              session.live
                ? "text-[#2dd4bf] font-medium"
                : selected
                ? "text-zinc-100 font-medium"
                : "text-zinc-300"
            }`}
          >
            {session.title || "Untitled session"}
          </span>
          <span className="block text-[11px] text-zinc-500 truncate mt-px tabular-nums">
            {session.repoName} · {statusLabel(session.status)} ·{" "}
            {formatTimeAgo(session.updatedAt)}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

function NavRow({
  item,
  active,
  badge,
  collapsed,
  onClick,
}: {
  item: AppNavItem;
  active: boolean;
  badge?: number;
  collapsed: boolean;
  onClick: () => void;
}) {
  const row = (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? item.label : undefined}
      aria-current={active ? "page" : undefined}
      className={`relative w-full rounded-md flex items-center gap-2 transition-colors ${
        collapsed ? "justify-center size-9 mx-auto" : "px-2 h-8"
      } ${
        active
          ? "bg-white/[0.07] text-zinc-100"
          : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04]"
      }`}
    >
      <span className={active ? "text-[#2dd4bf]" : ""} aria-hidden="true">
        {ICONS[item.id]}
      </span>
      {collapsed ? null : (
        <>
          <span className="text-[13px] truncate">{item.label}</span>
          {badge !== undefined && badge > 0 ? (
            <span className="ml-auto text-[11px] text-zinc-500 tabular-nums">
              {badge}
            </span>
          ) : null}
        </>
      )}
      {collapsed && badge !== undefined && badge > 0 ? (
        <span
          className="absolute top-1 right-1 size-1.5 rounded-full bg-[#4f9cf0]"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );

  if (!collapsed) return row;
  const tooltipContent =
    item.id === "vm" && badge !== undefined && badge > 0
      ? `${item.description} (${badge} active)`
      : item.description;
  return (
    <Tooltip content={tooltipContent} side="right">
      {row}
    </Tooltip>
  );
}

export function AppSidebar({
  activeView,
  onNavigate,
  collapsed = false,
  onToggleCollapse,
  isMobileDrawer = false,
  sessions,
  selectedId,
  onSelect,
  onNewTask,
  connectionLabel,
  connectionTone,
  activeSandboxCount,
  setupDone,
  setupTotal,
  onOpenSetup,
  onOpenShortcuts,
  theme,
  onToggleTheme,
}: AppSidebarProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.repoName.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const activeSessions = filtered.filter(
    (s) => s.live || s.status === "running" || s.status === "waiting-approval",
  );
  const recentSessions = filtered.filter((s) => !activeSessions.includes(s));
  const setupComplete = setupDone !== null && setupDone >= setupTotal;
  const setupRemaining =
    setupDone !== null ? Math.max(0, setupTotal - setupDone) : null;

  return (
    <aside
      className={`shrink-0 h-full flex flex-col bg-[#0d0d0f] border-r border-white/[0.07] select-none ${
        collapsed ? "w-14 items-center" : "w-[248px]"
      }`}
      aria-label="Sessions"
    >
      {/* Workspace header */}
      <div
        className={`relative flex items-center pt-3 pb-2 ${
          collapsed ? "justify-center px-0" : "gap-2 px-3"
        }`}
      >
        <a
          href="/"
          aria-label="AI Intern Home"
          className="flex items-center gap-2 min-w-0 focus:outline-none"
        >
          <span
            className="size-6 rounded-md bg-zinc-100 text-zinc-900 grid place-items-center text-[11px] font-semibold tracking-tight shrink-0"
            aria-hidden="true"
          >
            ai
          </span>
          {collapsed ? null : (
            <span className="text-[13px] font-medium text-zinc-100 tracking-[-0.01em] truncate">
              AI Intern
            </span>
          )}
        </a>
        {!collapsed && onToggleCollapse ? (
          <Tooltip
            content={isMobileDrawer ? "Close sessions drawer" : "Collapse sidebar"}
            shortcut={isMobileDrawer ? "Esc" : "⌘B"}
            side="bottom"
          >
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={isMobileDrawer ? "Close sessions" : "Collapse sidebar"}
              className="ml-auto size-6 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors shrink-0"
            >
              {isMobileDrawer ? (
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              )}
            </button>
          </Tooltip>
        ) : null}
      </div>

      {collapsed ? null : (
        <>
          {/* Search */}
          <div className="px-3 pb-2">
            <div className="relative">
              <svg
                className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-zinc-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z"
                />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                aria-label="Search sessions"
                className="w-full h-8 bg-white/[0.04] border border-transparent rounded-md pl-8 pr-7 text-[13px] text-zinc-200 placeholder:text-zinc-500 focus:border-white/[0.14] focus:bg-white/[0.05] focus:outline-none transition-colors"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-200 text-xs"
                >
                  ✕
                </button>
              ) : null}
            </div>
          </div>

          {/* Primary action */}
          <div className="px-3 pb-1.5">
            <button
              type="button"
              onClick={onNewTask}
              className="w-full inline-flex items-center justify-center gap-1.5 bg-zinc-100 hover:bg-white text-zinc-900 font-medium text-[13px] h-8 px-3 rounded-md transition-colors"
            >
              <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 4v16m8-8H4" />
              </svg>
              New task
            </button>
          </div>
        </>
      )}

      {/* Primary nav */}
      <nav
        className={`flex flex-col gap-0.5 ${collapsed ? "pt-2 px-0 w-full items-center" : "px-2 pt-1"}`}
        aria-label="Primary"
      >
        {APP_NAV_ITEMS.map((item) => (
          <NavRow
            key={item.id}
            item={item}
            active={activeView === item.id}
            badge={item.id === "vm" ? activeSandboxCount : undefined}
            collapsed={collapsed}
            onClick={() => onNavigate(item.id)}
          />
        ))}
        {collapsed ? (
          <Tooltip content="New task" side="right">
            <button
              type="button"
              onClick={onNewTask}
              aria-label="New task"
              className="size-9 mx-auto rounded-md flex items-center justify-center text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.04] transition-colors"
            >
              <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </Tooltip>
        ) : null}
      </nav>

      {/* Sessions */}
      {collapsed ? null : (
        <div className="flex-1 overflow-y-auto px-2 pb-2 mt-1 border-t border-white/[0.05]">
          <GroupLabel>Sessions</GroupLabel>
          {filtered.length === 0 ? (
            <p className="text-zinc-500 text-xs px-2 py-6 text-pretty">
              {sessions.length === 0
                ? "No sessions yet — start a task."
                : "No sessions match your search."}
            </p>
          ) : (
            <>
              {activeSessions.length > 0 ? (
                <section aria-label="Active sessions">
                  <ul className="flex flex-col gap-0.5">
                    {activeSessions.map((session) => (
                      <li key={session.id}>
                        <SessionRow
                          session={session}
                          selected={session.id === selectedId}
                          onSelect={onSelect}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {recentSessions.length > 0 ? (
                <section aria-label="Recent sessions">
                  {activeSessions.length > 0 ? <GroupLabel>Recent</GroupLabel> : null}
                  <ul className="flex flex-col gap-0.5">
                    {recentSessions.map((session) => (
                      <li key={session.id}>
                        <SessionRow
                          session={session}
                          selected={session.id === selectedId}
                          onSelect={onSelect}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
        </div>
      )}
      {collapsed ? <div className="flex-1" /> : null}

      {/* Utility footer */}
      <div
        className={`border-t border-white/[0.07] py-2 ${
          collapsed
            ? "flex flex-col items-center gap-0.5 px-0"
            : "flex items-center gap-0.5 px-2"
        }`}
      >
        {collapsed ? null : (
          <Tooltip content={`Agent State: ${connectionLabel}`} side="top">
            <span className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500 min-w-0 cursor-default px-1 mr-auto">
              <span
                className={`size-1.5 rounded-full shrink-0 ${connectionDotClass(connectionTone)}`}
                aria-hidden="true"
              />
              <span className="truncate">{connectionLabel}</span>
            </span>
          </Tooltip>
        )}

        <Tooltip
          content={
            setupComplete
              ? "Setup Guide (Completed)"
              : `Setup Guide (${setupDone ?? 0}/${setupTotal} completed)`
          }
          side={collapsed ? "right" : "top"}
        >
          <button
            type="button"
            onClick={onOpenSetup}
            aria-label="Setup Guide"
            className="relative size-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            {!setupComplete && setupRemaining !== null ? (
              <span
                className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 px-0.5 rounded-full bg-[#d9a13b] text-zinc-950 text-[9px] font-medium flex items-center justify-center"
                aria-hidden="true"
              >
                {setupRemaining}
              </span>
            ) : null}
          </button>
        </Tooltip>

        <Tooltip content="Documentation (opens /docs)" side={collapsed ? "right" : "top"}>
          <a
            href="/docs/"
            aria-label="Documentation"
            className="size-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" />
            </svg>
          </a>
        </Tooltip>

        <Tooltip content="Keyboard shortcuts" shortcut="?" side={collapsed ? "right" : "top"}>
          <button
            type="button"
            onClick={onOpenShortcuts}
            aria-label="Keyboard shortcuts"
            className="size-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
          >
            <span className="text-[11px] font-mono">?</span>
          </button>
        </Tooltip>

        {onToggleTheme ? (
          <Tooltip
            content={theme === "light" ? "Dark theme" : "Light theme"}
            shortcut="D"
            side={collapsed ? "right" : "top"}
          >
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
              className="size-7 rounded-md flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
            >
              {theme === "light" ? (
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              ) : (
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              )}
            </button>
          </Tooltip>
        ) : null}
      </div>
    </aside>
  );
}
