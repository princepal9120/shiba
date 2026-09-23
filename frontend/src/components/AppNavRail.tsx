/**
 * AppNavRail — left app sidebar (224px, all views).
 * Bezalel-style: logo block on top, grouped text nav with navy active
 * state, utility cluster (setup, docs, shortcuts, theme) at the bottom.
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
        "w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors duration-100 " +
        (active
          ? "bg-[#0000a8] text-white shadow-sm"
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

  return (
    <nav
      className="w-56 shrink-0 flex flex-col bg-[#f6f4ed] border-r border-[#e0ded5] py-3 px-3 z-30 select-none overflow-y-auto"
      aria-label="Primary"
    >
      {/* Brand */}
      <a href="/" className="flex items-center gap-2.5 px-1.5 pb-3 mb-1 group focus:outline-none" aria-label="AI Coworker Home">
        <img
          src="/assets/mascot/pet-logo.png"
          alt="Shiba"
          className="size-8 rounded-full bg-white object-contain border border-[#d3d2c8] transition-transform duration-200 group-hover:scale-105"
        />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            <span className="font-display text-lg leading-none text-[#222320]">AI Coworker</span>
            <span className="text-[9px] font-mono font-semibold uppercase tracking-wider text-[#0000a8] border border-[#0000a8]/25 bg-[#0000a8]/10 rounded px-1 py-px">
              Beta
            </span>
          </span>
          <span className="block text-[11px] text-[#6a6f63] leading-tight">agent plane</span>
        </span>
      </a>

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
                className="min-w-4 h-4 px-1 rounded-full bg-[#f99c00] text-white text-[9px] font-bold flex items-center justify-center"
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
          className="w-full flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] font-medium text-[#222320] hover:bg-[#e0ded5] hover:text-[#222320] transition-colors duration-100"
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
