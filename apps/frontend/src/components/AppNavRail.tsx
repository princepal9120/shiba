/**
 * AppNavRail — left app sidebar (224px, all views, lg+). Below lg the same
 * nav renders as a slide-in sheet (`variant="sheet"`) opened from the top bar.
 * Bezalel-style: logo block on top, grouped text nav with navy active
 * state, utility cluster (setup, docs, shortcuts, theme) at the bottom.
 */
import type { JSX } from "react";

export type AppNavView =
  | "dashboard"
  | "tasks"
  | "runs"
  | "diff"
  | "approvals"
  | "vm"
  | "agents"
  | "inbox"
  | "memory"
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
  { id: "dashboard", label: "Dashboard", description: "Overview & At-a-Glance Stats" },
  { id: "tasks", label: "Tasks", description: "Tasks & Live Sessions" },
  { id: "runs", label: "Runs", description: "Run Registry & Workspaces" },
  { id: "diff", label: "Diff", description: "Code Changes & Git Diffs" },
  { id: "approvals", label: "Approvals", description: "Review & Decision Queue" },
  { id: "vm", label: "VM", description: "VM Inspector & Terminals" },
  { id: "agents", label: "Agents & MCP", description: "MCP Gateway & Capability Scopes" },
  { id: "inbox", label: "Mailbox", description: "Cloudflare Email Routing & Send" },
  { id: "memory", label: "Memory", description: "Vectorize Long-Term Semantic Memory" },
  { id: "automations", label: "Automations", description: "Automations & Triggers" },
  { id: "missions", label: "Missions", description: "Missions & Standing Goals" },
  { id: "gates", label: "Gates", description: "Review, QA & Security Gates" },
  { id: "architecture", label: "Architecture", description: "System Architecture & Isolation" },
];

const NAV_GROUPS: { label: string; items: AppNavView[] }[] = [
  { label: "Workspace", items: ["dashboard", "tasks", "runs", "diff", "approvals", "missions", "automations"] },
  { label: "Capabilities", items: ["agents", "inbox", "memory"] },
  { label: "Sandbox & Safety", items: ["vm", "gates", "architecture"] },
];

export interface AppNavRailProps {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
  theme?: "dark" | "light";
  onToggleTheme?: () => void;
  activeSandboxCount: number;
  pendingApprovalCount?: number;
  setupDone: number | null;
  setupTotal: number;
  onOpenSetup: () => void;
  onOpenShortcuts: () => void;
  variant?: "rail" | "sheet";
  /** Sheet only: renders a close button in the brand row. */
  onClose?: () => void;
}

const ICONS: Record<AppNavView, JSX.Element> = {
  dashboard: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
    </svg>
  ),
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
  diff: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 7v10M8 7a2 2 0 100-4 2 2 0 000 4zm0 10a2 2 0 100 4 2 2 0 000-4zm8-6v6m0-6a2 2 0 100-4 2 2 0 000 4zm0 6a2 2 0 100 4 2 2 0 000-4z" />
    </svg>
  ),
  approvals: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  inbox: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
    </svg>
  ),
  memory: (
    <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
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
        "w-full flex items-center gap-2.5 rounded-none px-2.5 py-1.5 touch:min-h-11 text-[13px] font-medium transition-colors duration-100 " +
        (active
          ? "bg-[#0000a8] text-white shadow-[2px_2px_0_var(--paper-shadow)]"
          : "text-[#222320] hover:bg-[#e0ded5] hover:text-[#222320]")
      }
    >
      <span className={active ? "text-white" : "text-[#6a6f63]"} aria-hidden="true">
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
  pendingApprovalCount,
  setupDone,
  setupTotal,
  onOpenSetup,
  onOpenShortcuts,
  theme,
  onToggleTheme,
  variant = "rail",
  onClose,
}: AppNavRailProps): JSX.Element {
  const setupComplete = setupDone !== null && setupDone >= setupTotal;
  const setupRemaining =
    setupDone !== null ? Math.max(0, setupTotal - setupDone) : null;

  return (
    <nav
      className={
        variant === "sheet"
          ? "w-72 max-w-[85vw] h-full flex flex-col bg-[#f6f4ed] border-r border-[#e0ded5] px-3 pt-[max(0.75rem,env(safe-area-inset-top))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] select-none overflow-y-auto"
          : "hidden lg:flex w-56 shrink-0 flex-col bg-[#f6f4ed] border-r border-[#e0ded5] py-3 px-3 z-30 select-none overflow-y-auto"
      }
      aria-label="Primary"
    >
      <div className="flex items-start gap-2">
      {/* Brand */}
      <a href="/" className="flex-1 min-w-0 flex items-center gap-2.5 px-1.5 pb-3 mb-1 group focus:outline-none" aria-label="Shiba Home">
        <img
          src="/assets/mascot/pet-logo.png"
          alt="Shiba"
          className="size-8 rounded-full bg-white object-contain [image-rendering:pixelated] border border-[#d3d2c8] transition-transform duration-200 group-hover:scale-105"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="font-display text-lg leading-none text-[#222320]">Shiba</span>
            <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-[#0000a8] border border-[#0000a8]/25 bg-[#0000a8]/10 rounded-none px-1 py-px">
              Beta
            </span>
          </span>
          <span className="block text-[11px] text-[#6a6f63] leading-tight">agent plane</span>
        </span>
      </a>
      {onClose ? (
        <button
          type="button"
          onClick={onClose}
          aria-label="Close navigation"
          className="size-11 -mt-1.5 -mr-1.5 shrink-0 rounded-none flex items-center justify-center text-[#6a6f63] hover:text-[#222320] hover:bg-[#e0ded5] transition-colors"
        >
          <svg className="size-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ) : null}
      </div>

      {/* Grouped primary nav */}
      <div className="flex flex-col gap-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label}>
            <div className="px-2.5 pb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
              {group.label}
            </div>
            <div className="flex flex-col gap-0.5">
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
                          className="size-1.5 rounded-full bg-[#0000a8] animate-pulse"
                          aria-hidden="true"
                          title={`${activeSandboxCount} active`}
                        />
                      ) : item.id === "approvals" && pendingApprovalCount && pendingApprovalCount > 0 ? (
                        <span
                          className="min-w-4 h-4 px-1 rounded-none bg-[#f99c00] text-white text-[9px] font-bold flex items-center justify-center animate-pulse"
                          aria-hidden="true"
                        >
                          {pendingApprovalCount}
                        </span>
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
      <div className="mt-auto flex flex-col gap-0.5 pt-3 mt-4 border-t border-[#e0ded5]">
        <div className="px-2.5 pb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
          System
        </div>
        <NavItem
          label={setupComplete ? "Setup Guide" : `Setup Guide · ${setupDone ?? 0}/${setupTotal}`}
          onClick={onOpenSetup}
          badge={
            !setupComplete && setupRemaining !== null ? (
              <span
                className="min-w-4 h-4 px-1 rounded-none bg-[#f99c00] text-white text-[9px] font-bold flex items-center justify-center"
                aria-hidden="true"
              >
                {setupRemaining}
              </span>
            ) : undefined
          }
        >
          <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </NavItem>

        <a
          href="/docs/"
          aria-label="Documentation"
          className="w-full flex items-center gap-2.5 rounded-none px-2.5 py-1.5 touch:min-h-11 text-[13px] font-medium text-[#222320] hover:bg-[#e0ded5] hover:text-[#222320] transition-colors duration-100"
        >
          <span className="text-[#6a6f63]" aria-hidden="true">
            <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" />
            </svg>
          </span>
          <span className="flex-1 text-left truncate">Documentation</span>
        </a>

        <NavItem label="Keyboard shortcuts" onClick={onOpenShortcuts}>
          <span className="text-[11px] font-mono font-bold leading-none">?</span>
        </NavItem>

        {onToggleTheme ? (
          <NavItem
            label={theme === "light" ? "Dark theme" : "Light theme"}
            onClick={onToggleTheme}
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
          </NavItem>
        ) : null}
      </div>
    </nav>
  );
}
