/**
 * AppNavRail — left app sidebar (256px, all views).
 * Clean Superdesign styling: modern logo block on top, grouped nav with navy active
 * state and subtle shadow, setup progress widget and utility cluster at the bottom.
 */
import type { JSX } from "react";

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

const NAV_GROUPS: { label: string; items: AppNavView[] }[] = [
  { label: "Workspace", items: ["tasks", "runs", "missions", "automations"] },
  { label: "Sandbox", items: ["vm", "agents", "gates", "architecture"] },
];

export interface AppNavRailProps {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  activeSandboxCount: number;
  setupDone: number | null;
  setupTotal: number;
  onOpenSetup: () => void;
  onOpenShortcuts: () => void;
}

const ICONS: Record<AppNavView, JSX.Element> = {
  tasks: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  vm: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l6-6-6-6M12 19h8" />
    </svg>
  ),
  runs: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  agents: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  ),
  automations: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  missions: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />
    </svg>
  ),
  gates: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  architecture: (
    <svg className="size-4 shrink-0 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
    </svg>
  ),
};

function NavItem({
  label,
  active,
  onClick,
  children,
  badge,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={
        "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-all group " +
        (active
          ? "sidebar-item-active text-white"
          : "text-slate-600 hover:text-blue-600 hover:bg-slate-50")
      }
    >
      <span className={active ? "text-white" : "text-slate-400 group-hover:text-blue-600 transition-colors"} aria-hidden="true">
        {children}
      </span>
      <span className="flex-1 text-left truncate">{label}</span>
      {badge}
    </button>
  );
}

export function AppNavRail({
  activeView,
  onNavigate,
  activeSandboxCount,
  setupDone,
  setupTotal,
  onOpenSetup,
  onOpenShortcuts,
  theme,
  onToggleTheme,
}: AppNavRailProps): JSX.Element {
  const setupComplete = setupDone !== null && setupDone >= setupTotal;
  const setupRemaining =
    setupDone !== null ? Math.max(0, setupTotal - setupDone) : null;
  const progressPercent = setupDone !== null ? Math.min(100, Math.round((setupDone / setupTotal) * 100)) : 16;

  return (
    <nav
      className="w-64 shrink-0 flex flex-col bg-white border-r border-slate-200 py-4 px-4 z-30 select-none overflow-y-auto"
      aria-label="Primary"
    >
      {/* Brand */}
      <a href="/" className="flex items-center gap-3 px-1 pb-4 mb-2 border-b border-slate-100 group focus:outline-none" aria-label="AI Coworker Home">
        <div className="size-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-md shadow-blue-200 transition-transform duration-200 group-hover:scale-105 shrink-0">
          <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-slate-900 text-base leading-tight tracking-tight">AI Coworker</span>
            <span className="text-[10px] font-bold uppercase tracking-wider text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100">
              Beta
            </span>
          </div>
          <span className="block text-[11px] text-slate-400 font-medium">agent plane</span>
        </div>
      </a>

      {/* Grouped primary nav */}
      <div className="flex flex-col gap-5 py-2">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2 mb-2 text-[11px] font-semibold text-slate-400 uppercase tracking-[0.1em]">
              {group.label}
            </div>
            <div className="flex flex-col gap-1">
              {group.items.map((id) => {
                const item = APP_NAV_ITEMS.find((entry) => entry.id === id);
                if (!item) return null;
                return (
                  <NavItem
                    key={item.id}
                    label={item.label}
                    active={activeView === item.id}
                    onClick={() => onNavigate(item.id)}
                    badge={
                      item.id === "vm" && activeSandboxCount > 0 ? (
                        <span
                          className="size-2 rounded-full bg-blue-500 animate-pulse"
                          aria-hidden="true"
                          title={`${activeSandboxCount} active`}
                        />
                      ) : undefined
                    }
                  >
                    {ICONS[item.id]}
                  </NavItem>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Utility cluster */}
      <div className="mt-auto flex flex-col pt-3 border-t border-slate-100">
        {/* Setup guide card with progress bar */}
        <div className="p-3 bg-slate-50/90 rounded-xl mb-3 border border-slate-100/80">
          <button
            type="button"
            onClick={onOpenSetup}
            className="w-full text-left focus:outline-none group"
            aria-label="Setup Guide"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-bold text-slate-500 tracking-wider">SETUP GUIDE</span>
              <span className="text-[11px] font-bold text-blue-600">
                {setupDone ?? 0}/{setupTotal}
              </span>
            </div>
            <div className="h-1.5 w-full bg-slate-200/80 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 rounded-full transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            {!setupComplete && setupRemaining !== null && (
              <span className="text-[10px] text-slate-400 mt-1 block">
                {setupRemaining} step{setupRemaining === 1 ? "" : "s"} remaining
              </span>
            )}
          </button>
        </div>

        <div className="px-2 mb-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-[0.1em]">
          System
        </div>
        <div className="space-y-0.5">
          <NavItem
            label={setupComplete ? "Setup Guide" : `Setup Guide · ${setupDone ?? 0}/${setupTotal}`}
            onClick={onOpenSetup}
          >
            <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </NavItem>

          <a
            href="/docs/"
            aria-label="Documentation"
            className="w-full flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] font-medium text-slate-600 hover:text-blue-600 hover:bg-slate-50 transition-colors"
          >
            <span className="text-slate-400 hover:text-blue-600" aria-hidden="true">
              <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
            </span>
            <span className="flex-1 text-left truncate">Documentation</span>
          </a>

          <NavItem label="Keyboard shortcuts" onClick={onOpenShortcuts}>
            <span className="text-[11px] font-mono font-bold leading-none w-4 text-center">?</span>
          </NavItem>

          {onToggleTheme ? (
            <NavItem
              label={theme === "light" ? "Dark theme" : "Light theme"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? (
                <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              ) : (
                <svg className="size-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              )}
            </NavItem>
          ) : null}
        </div>
      </div>
    </nav>
  );
}

