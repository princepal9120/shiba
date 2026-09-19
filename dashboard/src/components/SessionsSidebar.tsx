/**
 * SessionsSidebar — Devin-style left rail (~300px).
 * Lists chat/run sessions with status dots, search filter, New Task CTA,
 * and a footer with setup progress, docs link, and connection state.
 */
import { useMemo, useState } from "react";
import { formatTimeAgo } from "../ui-helpers";

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
}

function statusDotClass(session: SessionItem): string {
  if (session.live || session.status === "live" || session.status === "running") {
    return "bg-[#0B9F95] animate-pulse-subtle";
  }
  if (session.status === "waiting-approval" || session.status === "pending") {
    return "bg-[#f59e0b]";
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
  return "bg-[#8b98a9]";
}

function connectionDotClass(tone: SessionsSidebarProps["connectionTone"]): string {
  if (tone === "ok") return "bg-[#4cc38a]";
  if (tone === "pending") return "bg-[#f59e0b] animate-pulse-subtle";
  return "bg-[#f06666]";
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

  const setupComplete = setupDone !== null && setupDone >= setupTotal;

  return (
    <aside
      className="w-[300px] shrink-0 h-full flex flex-col bg-[#0a0c10] border-r border-[#1e2530]"
      aria-label="Sessions"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[#e6edf3] font-display tracking-tight">
            Sessions
          </h2>
          <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-[#11141b] border border-[#1e2530] text-[#8b98a9]">
            {sessions.length}
          </span>
        </div>
      </div>

      {/* New task */}
      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={onNewTask}
          className="w-full inline-flex items-center justify-center gap-1.5 bg-[#0B9F95] hover:bg-[#0c8d84] text-black font-semibold text-sm py-2 px-3 rounded-lg transition-colors shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
          </svg>
          New task
        </button>
      </div>

      {/* Search */}
      <div className="px-4 pb-3">
        <div className="relative">
          <svg
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#8b98a9]"
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
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="w-full bg-[#11141b] border border-[#1e2530] rounded-lg pl-8 pr-3 py-1.5 text-sm text-[#e6edf3] placeholder:text-[#8b98a9]/60 focus:border-[#2dd4bf]/50 transition-colors"
          />
        </div>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {filtered.length === 0 ? (
          <p className="text-[#8b98a9] text-xs px-3 py-6 text-center">
            {sessions.length === 0
              ? "No sessions yet — start a task."
              : "No sessions match your search."}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {filtered.map((session) => {
              const selected = session.id === selectedId;
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(session.id)}
                    aria-current={selected ? "true" : undefined}
                    className={`w-full text-left rounded-lg px-3 py-2.5 flex items-start gap-2.5 transition-colors border ${
                      selected
                        ? "bg-[#11141b] border-[#2c3545]"
                        : "bg-transparent border-transparent hover:bg-[#11141b]/70"
                    }`}
                  >
                    <span
                      className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${statusDotClass(session)}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm text-[#e6edf3] truncate leading-snug">
                        {session.title || "Untitled session"}
                      </span>
                      <span className="block text-[11px] font-mono text-[#8b98a9] truncate mt-0.5">
                        {session.repoName} · {formatTimeAgo(session.updatedAt)}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer */}
      <div className="border-t border-[#1e2530] px-4 py-3 flex flex-col gap-2.5">
        <button
          type="button"
          onClick={onOpenSetup}
          className={`inline-flex items-center gap-2 text-xs font-semibold rounded-lg px-2.5 py-1.5 border transition-colors w-fit ${
            setupComplete
              ? "text-[#2dd4bf] border-[#0B9F95]/40 bg-[#0B9F95]/10 hover:bg-[#0B9F95]/20"
              : "text-[#f59e0b] border-[#f59e0b]/40 bg-[#f59e0b]/10 hover:bg-[#f59e0b]/20"
          }`}
        >
          {setupComplete
            ? "Setup Guide"
            : `Setup ${setupDone ?? 0}/${setupTotal}`}
        </button>
        <div className="flex items-center justify-between">
          <a
            href="/docs"
            className="text-xs text-[#8b98a9] hover:text-[#e6edf3] transition-colors"
          >
            Docs
          </a>
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[#8b98a9]">
            <span
              className={`w-1.5 h-1.5 rounded-full ${connectionDotClass(connectionTone)}`}
              aria-hidden="true"
            />
            {connectionLabel}
          </span>
        </div>
      </div>
    </aside>
  );
}
