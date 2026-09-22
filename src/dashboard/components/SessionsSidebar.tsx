/**
 * SessionsSidebar — Devin-style left rail (280px).
 * Sessions grouped "Active" (live chat pinned) then "Recent" (runs,
 * newest first). Borderless rows: status dot + title + mono meta line.
 * Footer carries setup progress, docs link, and connection state.
 */
import { useMemo, useState } from "react";
import { formatTimeAgo, statusLabel } from "../ui-helpers";
import { Tooltip } from "./Tooltip";

export interface SessionItem {
  id: string; // runId, or "live" for the active chat session
  title: string; // task text (truncate display, not data)
  repoName: string; // parseRepoName(repoUrl)
  status: string; // pending|running|completed|error|aborted|cancelled|waiting-approval|live
  updatedAt: number;
  live?: boolean;
}

export interface SessionsSidebarProps {
  sessions: SessionItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNewTask: () => void;
  connectionLabel: string; // "Connected" | "Connecting" | error text
  connectionTone: "ok" | "pending" | "error";
  setupDone: number | null;
  setupTotal: number;
  onOpenSetup: () => void;
  onToggleCollapse?: () => void;
  isMobileDrawer?: boolean;
}

export function statusDotClass(session: SessionItem): string {
  if (session.live || session.status === "live" || session.status === "running") {
    return "bg-[#0B9F95] animate-pulse-subtle";
  }
  if (session.status === "waiting-approval" || session.status === "pending") {
    return "bg-[#c9a227]";
  }
  if (session.status === "completed") {
    return "bg-[#4cc38a]";
  }
  // Amber, not red: an ambiguous outcome is not a known failure.
  if (session.status === "unknown") {
    return "bg-[#d97706]";
  }
  if (
    session.status === "error" ||
    session.status === "aborted" ||
    session.status === "cancelled"
  ) {
    return "bg-[#f06666]";
  }
  return "bg-[#8b98a9]";
}

function connectionDotClass(tone: SessionsSidebarProps["connectionTone"]): string {
  if (tone === "ok") return "bg-[#4cc38a]";
  if (tone === "pending") return "bg-[#c9a227] animate-pulse-subtle";
  return "bg-[#f06666]";
}

function GroupLabel({ children }: { children: string }) {
  return (
    <h3 className="px-3 pt-3.5 pb-1.5 text-[10px] font-mono font-semibold uppercase tracking-[0.1em] text-[#8b98a9]/60 select-none">
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
        className={`group w-full text-left rounded-lg px-3 py-2 flex items-start gap-2.5 transition-colors ${
          selected ? "bg-[#161a22] text-white shadow-sm" : "hover:bg-white/[0.04] text-[#e6edf3]"
        }`}
      >
        <span
          className={`mt-[7px] size-1.5 rounded-full shrink-0 ${statusDotClass(session)}`}
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span
            className={`block text-[13px] font-medium truncate leading-snug ${
              session.live ? "text-[#2dd4bf]" : selected ? "text-white" : "text-[#e6edf3]"
            }`}
          >
            {session.title || "Untitled session"}
          </span>
          <span className="block text-[11px] font-mono text-[#8b98a9]/80 truncate mt-0.5 tabular-nums">
            {session.repoName} · {statusLabel(session.status)} ·{" "}
            {formatTimeAgo(session.updatedAt)}
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

export function SessionsSidebar({
  sessions,
  selectedId,
  onSelect,
  onNewTask,
  connectionLabel,
  connectionTone,
  setupDone,
  setupTotal,
  onOpenSetup,
  onToggleCollapse,
  isMobileDrawer = false,
}: SessionsSidebarProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) || s.repoName.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  const activeSessions = filtered.filter((s) => s.live || s.status === "running" || s.status === "waiting-approval");
  const recentSessions = filtered.filter((s) => !activeSessions.includes(s));
  const setupComplete = setupDone !== null && setupDone >= setupTotal;

  return (
    <aside
      className="w-[280px] shrink-0 h-full flex flex-col bg-[#0a0c10] border-r border-[#1e2530]"
      aria-label="Sessions"
    >
      {/* Header with collapse button */}
      <div className="flex items-center justify-between px-3.5 pt-3.5 pb-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-[11px] font-mono font-semibold uppercase tracking-[0.12em] text-[#8b98a9]">
            Sessions
          </h2>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-[#11141b] border border-white/[0.06] text-[#8b98a9] tabular-nums">
            {sessions.length}
          </span>
        </div>

        {onToggleCollapse ? (
          <Tooltip content={isMobileDrawer ? "Close sessions drawer" : "Collapse sidebar"} shortcut={isMobileDrawer ? "Esc" : "⌘B"} side="bottom">
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label={isMobileDrawer ? "Close sessions" : "Collapse sidebar"}
              className="size-7 rounded-md flex items-center justify-center text-[#8b98a9] hover:text-[#e6edf3] hover:bg-white/[0.06] transition-colors"
            >
              {isMobileDrawer ? (
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
                </svg>
              )}
            </button>
          </Tooltip>
        ) : null}
      </div>

      {/* New task button */}
      <div className="px-3 pb-2.5">
        <Tooltip content="Start a new coding task session" side="bottom">
          <button
            type="button"
            onClick={onNewTask}
            className="w-full inline-flex items-center justify-center gap-1.5 bg-[#0B9F95] hover:bg-[#2dd4bf] text-black font-semibold text-[13px] h-9 px-3 rounded-lg transition-colors shadow-sm"
          >
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
            </svg>
            New task
          </button>
        </Tooltip>
      </div>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-[#8b98a9]/60"
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
            placeholder="Search sessions…"
            aria-label="Search sessions"
            className="w-full h-8 bg-[#11141b] border border-transparent rounded-lg pl-8 pr-7 text-[13px] text-[#e6edf3] placeholder:text-[#8b98a9]/50 focus:border-[#2dd4bf]/40 focus:outline-none transition-colors"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8b98a9] hover:text-white text-xs"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <p className="text-[#8b98a9] text-xs px-3 py-8 text-center text-pretty">
            {sessions.length === 0
              ? "No sessions yet — start a task."
              : "No sessions match your search."}
          </p>
        ) : (
          <>
            {activeSessions.length > 0 ? (
              <section aria-label="Active sessions">
                <GroupLabel>Active</GroupLabel>
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
                <GroupLabel>Recent</GroupLabel>
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

      {/* Footer */}
      <div className="border-t border-[#1e2530] px-3 py-3 flex flex-col gap-2.5 bg-[#07090e]/50">
        <Tooltip content={setupComplete ? "All 6 setup steps verified" : `${setupDone ?? 0} of ${setupTotal} setup steps complete`} side="top">
          <button
            type="button"
            onClick={onOpenSetup}
            className={`inline-flex items-center gap-2 text-xs font-semibold rounded-lg px-2.5 py-1.5 border transition-colors w-fit ${
              setupComplete
                ? "text-[#2dd4bf] border-[#0B9F95]/40 bg-[#0B9F95]/10 hover:bg-[#0B9F95]/20"
                : "text-[#c9a227] border-[#c9a227]/40 bg-[#c9a227]/10 hover:bg-[#c9a227]/20"
            }`}
          >
            {setupComplete ? "Setup Guide" : `Setup ${setupDone ?? 0}/${setupTotal}`}
          </button>
        </Tooltip>
        <div className="flex items-center justify-between gap-2">
          <Tooltip content="Documentation & API guides" side="top">
            <a
              href="/docs"
              className="text-xs text-[#8b98a9] hover:text-[#e6edf3] transition-colors shrink-0"
            >
              Docs
            </a>
          </Tooltip>
          <Tooltip content={`Agent State: ${connectionLabel}`} side="top">
            <span
              className="inline-flex items-center gap-1.5 text-[11px] text-[#8b98a9] min-w-0 cursor-default"
            >
              <span
                className={`size-1.5 rounded-full shrink-0 ${connectionDotClass(connectionTone)}`}
                aria-hidden="true"
              />
              <span className="truncate">{connectionLabel}</span>
            </span>
          </Tooltip>
        </div>
      </div>
    </aside>
  );
}

