/**
 * AppNavRail — leftmost app navigation rail (56px, all views).
 * Devin/Linear-style icon rail: logo on top, vertical icon nav with
 * active indicator, utility cluster (setup, docs, shortcuts) pinned
 * to the bottom. Replaces the old top navbar tabs.
 */
import type { JSX } from "react";
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
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  vm: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l6-6-6-6M12 19h8" />
    </svg>
  ),
  runs: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 5.14v14l11-7-11-7z" />
    </svg>
  ),
  agents: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
    </svg>
  ),
  automations: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  ),
  missions: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7" />
    </svg>
  ),
  gates: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  architecture: (
    <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z" />
    </svg>
  ),
};

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={
        "relative size-10 rounded-lg flex items-center justify-center transition-all duration-150 " +
        (active
          ? "text-[#2dd4bf] bg-[#0B9F95]/15 shadow-[inset_0_0_0_1px_rgba(45,212,191,0.25)]"
          : "text-[#8b98a9] hover:text-[#e6edf3] hover:bg-white/[0.05]")
      }
    >
      {active ? (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-[#2dd4bf] shadow-[0_0_8px_rgba(45,212,191,0.6)]"
          aria-hidden="true"
        />
      ) : null}
      {children}
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
      className="w-14 shrink-0 flex flex-col items-center bg-[#07090e] border-r border-[#1e2530] py-3 gap-1 z-30 select-none"
      aria-label="Primary"
    >
      {/* Brand */}
      <Tooltip content="AI Intern · Cloudflare Native" side="right">
        <a href="/" className="mb-3 block group focus:outline-none" aria-label="AI Intern Home">
          <img
            src="/assets/mascot/pet-logo.png"
            alt="Shiba"
            className="size-9 rounded-full bg-white object-contain border border-teal-500/50 shadow-[0_0_12px_rgba(11,159,149,0.35)] transition-transform duration-200 group-hover:scale-105 group-hover:shadow-[0_0_16px_rgba(45,212,191,0.5)]"
          />
        </a>
      </Tooltip>

      {/* Primary nav */}
      <div className="flex flex-col items-center gap-1">
        {APP_NAV_ITEMS.map((item) => {
          const tooltipContent =
            item.id === "vm" && activeSandboxCount > 0
              ? `${item.description} (${activeSandboxCount} active)`
              : item.description;

          return (
            <Tooltip key={item.id} content={tooltipContent} side="right">
              <RailButton
                label={item.label}
                active={activeView === item.id}
                onClick={() => onNavigate(item.id)}
              >
                {ICONS[item.id]}
                {item.id === "vm" && activeSandboxCount > 0 ? (
                  <span
                    className="absolute top-1 right-1 size-2 rounded-full bg-[#4f9cf0] shadow-[0_0_6px_#4f9cf0] animate-pulse"
                    aria-hidden="true"
                  />
                ) : null}
              </RailButton>
            </Tooltip>
          );
        })}
      </div>

      {/* Utility cluster */}
      <div className="mt-auto flex flex-col items-center gap-1 pt-3 border-t border-[#1e2530]/60 w-full">
        <Tooltip
          content={
            setupComplete
              ? "Setup Guide (Completed)"
              : `Setup Guide (${setupDone ?? 0}/${setupTotal} completed)`
          }
          side="right"
        >
          <RailButton label="Setup Guide" onClick={onOpenSetup}>
            <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
            {!setupComplete && setupRemaining !== null ? (
              <span
                className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-[#c9a227] text-black text-[9px] font-bold flex items-center justify-center shadow-sm"
                aria-hidden="true"
              >
                {setupRemaining}
              </span>
            ) : null}
          </RailButton>
        </Tooltip>

        <Tooltip content="Documentation (opens /docs)" side="right">
          <a
            href="/docs/"
            aria-label="Documentation"
            className="relative size-10 rounded-lg flex items-center justify-center transition-colors text-[#8b98a9] hover:text-[#e6edf3] hover:bg-white/[0.05]"
          >
            <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" />
            </svg>
          </a>
        </Tooltip>

        <Tooltip content="Keyboard shortcuts" shortcut="?" side="right">
          <RailButton label="Keyboard shortcuts" onClick={onOpenShortcuts}>
            <span className="text-xs font-mono font-bold">?</span>
          </RailButton>
        </Tooltip>

        {onToggleTheme ? (
          <Tooltip
            content={theme === "light" ? "Dark theme" : "Light theme"}
            shortcut="D"
            side="right"
          >
            <RailButton
              label={theme === "light" ? "Switch to dark theme" : "Switch to light theme"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? (
                <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
                </svg>
              ) : (
                <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
                </svg>
              )}
            </RailButton>
          </Tooltip>
        ) : null}
      </div>
    </nav>
  );
}
