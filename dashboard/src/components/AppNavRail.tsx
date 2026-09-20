/**
 * AppNavRail — leftmost app navigation rail (56px, all views).
 * Devin/Linear-style icon rail: logo on top, vertical icon nav with
 * active indicator, utility cluster (setup, docs, shortcuts) pinned
 * to the bottom. Replaces the old top navbar tabs.
 */
import type { JSX } from "react";

export type AppNavView =
  | "tasks"
  | "vm"
  | "runs"
  | "automations"
  | "missions"
  | "gates"
  | "architecture";

export interface AppNavItem {
  id: AppNavView;
  label: string;
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  { id: "tasks", label: "Tasks" },
  { id: "vm", label: "VM" },
  { id: "runs", label: "Runs" },
  { id: "automations", label: "Automations" },
  { id: "missions", label: "Missions" },
  { id: "gates", label: "Gates" },
  { id: "architecture", label: "Architecture" },
];

export interface AppNavRailProps {
  activeView: AppNavView;
  onNavigate: (view: AppNavView) => void;
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
  title,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={title ?? label}
      className={
        "relative size-10 rounded-lg flex items-center justify-center transition-colors " +
        (active
          ? "text-[#2dd4bf] bg-[#0B9F95]/15"
          : "text-[#8b98a9] hover:text-[#e6edf3] hover:bg-white/[0.05]")
      }
    >
      {active ? (
        <span
          className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-[#2dd4bf]"
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
}: AppNavRailProps): JSX.Element {
  const setupComplete = setupDone !== null && setupDone >= setupTotal;
  const setupRemaining =
    setupDone !== null ? Math.max(0, setupTotal - setupDone) : null;

  return (
    <nav
      className="w-14 shrink-0 flex flex-col items-center bg-[#07090e] border-r border-[#1e2530] py-3 gap-1"
      aria-label="Primary"
    >
      {/* Brand */}
      <a href="/" className="mb-3 block" title="Shiba — Cloudflare Native" aria-label="Shiba home">
        <img
          src="/assets/mascot/pet-logo.png"
          alt="Shiba"
          className="size-9 rounded-full bg-white object-contain border border-teal-500/50 shadow-[0_0_12px_rgba(11,159,149,0.4)]"
        />
      </a>

      {/* Primary nav */}
      <div className="flex flex-col items-center gap-1">
        {APP_NAV_ITEMS.map((item) => (
          <RailButton
            key={item.id}
            label={item.label}
            active={activeView === item.id}
            onClick={() => onNavigate(item.id)}
          >
            {ICONS[item.id]}
            {item.id === "vm" && activeSandboxCount > 0 ? (
              <span
                className="absolute top-1 right-1 size-1.5 rounded-full bg-[#4f9cf0]"
                aria-hidden="true"
              />
            ) : null}
          </RailButton>
        ))}
      </div>

      {/* Utility cluster */}
      <div className="mt-auto flex flex-col items-center gap-1 pt-3 border-t border-[#1e2530]/60 w-full">
        <RailButton
          label="Setup Guide"
          title={
            setupComplete
              ? "Setup Guide"
              : "Setup " + (setupDone ?? 0) + "/" + setupTotal + " — open guide"
          }
          onClick={onOpenSetup}
        >
          <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
          {!setupComplete && setupRemaining !== null ? (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 rounded-full bg-[#c9a227] text-black text-[9px] font-bold flex items-center justify-center"
              aria-hidden="true"
            >
              {setupRemaining}
            </span>
          ) : null}
        </RailButton>
        <a
          href="/docs/"
          aria-label="Docs"
          title="Docs"
          className="relative size-10 rounded-lg flex items-center justify-center transition-colors text-[#8b98a9] hover:text-[#e6edf3] hover:bg-white/[0.05]"
        >
          <svg className="size-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 006.5 22H20V2H6.5A2.5 2.5 0 004 4.5v15z" />
          </svg>
        </a>
        <RailButton label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={onOpenShortcuts}>
          <span className="text-xs font-mono font-bold">?</span>
        </RailButton>
      </div>
    </nav>
  );
}
