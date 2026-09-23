/**
 * AppNavRail — left app sidebar for the Bezalel paper-dashboard layout.
 * Features:
 * - Authentic Bezalel branding: Shiba mascot, Instrument Serif title, 'Beta' badge, 'capability plane' tag
 * - Grouped sections: Plane & Capabilities using authentic Bezalel PixelIcons
 * - Collapsible icon rail support (240px expanded vs 60px collapsed) with Tooltips
 * - Retro paper active states with 2px hard paper drop shadows
 * - Setup Guide progress card + operator indicator + quick utilities at bottom
 */
import type { JSX, ReactNode } from "react";
import { PixelIcon, type PixelIconName } from "./ui/PixelIcon";
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
  icon: PixelIconName;
}

export const APP_NAV_ITEMS: AppNavItem[] = [
  { id: "tasks", label: "Tasks", description: "Tasks & Live Sessions", icon: "Overview" },
  { id: "runs", label: "Runs", description: "Run Registry & Workspaces", icon: "Activity" },
  { id: "agents", label: "Agents", description: "Agent CLIs in the Sandbox Image", icon: "Agents" },
  { id: "missions", label: "Missions", description: "Missions & Standing Goals", icon: "Skills" },
  { id: "automations", label: "Automations", description: "Automations & Triggers", icon: "Operations" },
  { id: "vm", label: "VM", description: "VM Inspector & Terminals", icon: "A computer" },
  { id: "gates", label: "Gates", description: "Review, QA & Security Gates", icon: "Sandboxes" },
  { id: "architecture", label: "Architecture", description: "System Architecture & Isolation", icon: "Connectors" },
];

const NAV_GROUPS: { label: string; items: AppNavView[] }[] = [
  { label: "Plane", items: ["tasks", "runs", "agents", "missions", "automations"] },
  { label: "Capabilities", items: ["vm", "gates", "architecture"] },
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
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

interface NavItemProps {
  label: string;
  description?: string;
  active?: boolean;
  collapsed?: boolean;
  onClick: () => void;
  children: ReactNode;
  badge?: ReactNode;
}

function NavItem({
  label,
  description,
  active,
  collapsed,
  onClick,
  children,
  badge,
}: NavItemProps) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={
        "w-full flex items-center gap-3 px-2.5 py-1.5 text-[13px] transition-all select-none rounded-none " +
        (active
          ? "sidebar-item-active"
          : "text-[var(--sidebar-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)]") +
        (collapsed ? " justify-center px-1" : "")
      }
    >
      <span
        className={
          "shrink-0 " +
          (active
            ? "text-white"
            : "text-[var(--muted-foreground)] group-hover:text-[var(--foreground)] transition-colors")
        }
        aria-hidden="true"
      >
        {children}
      </span>
      {!collapsed ? (
        <>
          <span className="flex-1 text-left truncate font-medium">{label}</span>
          {badge}
        </>
      ) : null}
    </button>
  );

  if (collapsed) {
    return (
      <Tooltip content={description || label} side="right">
        {button}
      </Tooltip>
    );
  }

  return button;
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
  collapsed = false,
  onToggleCollapse,
}: AppNavRailProps): JSX.Element {
  const setupComplete = setupDone !== null && setupDone >= setupTotal;
  const setupRemaining =
    setupDone !== null ? Math.max(0, setupTotal - setupDone) : null;
  const progressPercent =
    setupDone !== null ? Math.min(100, Math.round((setupDone / setupTotal) * 100)) : 16;

  return (
    <aside
      className={
        "shrink-0 flex flex-col bg-[var(--sidebar)] border-r border-[var(--sidebar-border)] transition-[width] duration-200 ease-in-out z-30 select-none " +
        (collapsed ? "w-16" : "w-60 lg:w-64")
      }
      aria-label="Sidebar navigation"
    >
      {/* Brand Header — Bezalel style with Shiba mascot */}
      <div className="h-14 shrink-0 flex items-center justify-between border-b border-[var(--sidebar-border)] px-3">
        <a
          href="/"
          className={
            "flex items-center gap-2.5 min-w-0 group focus:outline-none " +
            (collapsed ? "justify-center w-full" : "")
          }
          aria-label="Shiba capability plane home"
        >
          <img
            src="/assets/theme/circle_shiba.svg"
            alt="Shiba"
            className="size-8 shrink-0 object-contain [image-rendering:pixelated] group-hover:scale-105 transition-transform"
            draggable={false}
          />
          {!collapsed ? (
            <div className="flex flex-col min-w-0 leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="font-serif text-2xl text-[var(--sidebar-foreground)] tracking-tight">
                  Shiba
                </span>
                <span className="text-[10px] font-mono uppercase tracking-wider text-[var(--muted-foreground)] px-1 py-0.5 border border-[var(--sidebar-border)] bg-[var(--background)]">
                  Beta
                </span>
              </div>
              <span className="text-[11px] font-mono text-[var(--muted-foreground)] truncate">
                capability plane
              </span>
            </div>
          ) : null}
        </a>

        {!collapsed && onToggleCollapse ? (
          <Tooltip content="Collapse sidebar" shortcut="⌘B" side="right">
            <button
              type="button"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
              aria-expanded="true"
              className="size-7 rounded-none border border-transparent hover:border-[var(--sidebar-border)] text-[var(--muted-foreground)] hover:text-[var(--sidebar-foreground)] hover:bg-[var(--secondary)] flex items-center justify-center transition-colors"
            >
              <svg className="size-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          </Tooltip>
        ) : null}
      </div>

      {/* Navigation Groups */}
      <div className="flex-1 overflow-y-auto py-3 px-2 flex flex-col gap-4">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-1">
            {!collapsed ? (
              <div className="px-2 mb-1 text-[11px] font-mono font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">
                {group.label}
              </div>
            ) : null}
            <div className="flex flex-col gap-0.5">
              {group.items.map((id) => {
                const item = APP_NAV_ITEMS.find((entry) => entry.id === id);
                if (!item) return null;
                const isActive = activeView === item.id;
                return (
                  <NavItem
                    key={item.id}
                    label={item.label}
                    description={item.description}
                    active={isActive}
                    collapsed={collapsed}
                    onClick={() => onNavigate(item.id)}
                    badge={
                      item.id === "vm" && activeSandboxCount > 0 ? (
                        <span
                          className="size-2 rounded-full bg-[#0000a8] dark:bg-[#9cbce2] animate-pulse"
                          aria-hidden="true"
                          title={activeSandboxCount + " active"}
                        />
                      ) : undefined
                    }
                  >
                    <PixelIcon
                      name={item.icon}
                      size={18}
                      color={isActive ? "#ffffff" : "currentColor"}
                    />
                  </NavItem>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer Cluster */}
      <div className="mt-auto shrink-0 flex flex-col border-t border-[var(--sidebar-border)] p-2 gap-2 bg-[var(--sidebar)]">
        {/* Setup guide progress card */}
        {!collapsed ? (
          <div className="p-2.5 bg-[var(--card)] border border-[var(--sidebar-border)] shadow-[2px_2px_0_var(--paper-shadow)] mb-1">
            <button
              type="button"
              onClick={onOpenSetup}
              className="w-full text-left focus:outline-none group"
              aria-label="Setup Guide"
            >
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-mono font-bold text-[var(--muted-foreground)] tracking-wider">
                  SETUP GUIDE
                </span>
                <span className="text-[11px] font-mono font-bold text-[var(--primary)]">
                  {(setupDone ?? 0) + "/" + setupTotal}
                </span>
              </div>
              <div className="h-1.5 w-full bg-[var(--sidebar-border)] overflow-hidden">
                <div
                  className="h-full bg-[var(--primary)] transition-all duration-300"
                  style={{ width: progressPercent + "%" }}
                />
              </div>
              {!setupComplete && setupRemaining !== null && (
                <span className="text-[10px] text-[var(--muted-foreground)] mt-1.5 block">
                  {setupRemaining + " step" + (setupRemaining === 1 ? "" : "s") + " remaining"}
                </span>
              )}
            </button>
          </div>
        ) : null}

        {/* System & Utility Links */}
        <div className="flex flex-col gap-0.5">
          <NavItem
            label={setupComplete ? "Setup Guide" : "Setup Guide · " + (setupDone ?? 0) + "/" + setupTotal}
            collapsed={collapsed}
            onClick={onOpenSetup}
          >
            <PixelIcon name="Admin" size={16} />
          </NavItem>

          {collapsed ? (
            <Tooltip content="Documentation" side="right">
              <a
                href="/docs/"
                aria-label="Documentation"
                className="w-full flex items-center justify-center p-2 text-[var(--sidebar-foreground)] hover:bg-[var(--secondary)] transition-colors"
              >
                <PixelIcon name="Overview" size={16} />
              </a>
            </Tooltip>
          ) : (
            <a
              href="/docs/"
              aria-label="Documentation"
              className="w-full flex items-center gap-3 px-2.5 py-1.5 text-[13px] font-medium text-[var(--sidebar-foreground)] hover:bg-[var(--secondary)] hover:text-[var(--foreground)] transition-colors"
            >
              <span className="text-[var(--muted-foreground)]" aria-hidden="true">
                <PixelIcon name="Overview" size={16} />
              </span>
              <span className="flex-1 text-left truncate">Documentation</span>
            </a>
          )}

          <NavItem label="Keyboard shortcuts" collapsed={collapsed} onClick={onOpenShortcuts}>
            <span className="text-[11px] font-mono font-bold leading-none w-4 text-center">?</span>
          </NavItem>

          {onToggleTheme ? (
            <NavItem
              label={theme === "light" ? "Dark theme" : "Light theme"}
              collapsed={collapsed}
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

          {/* Operator Profile Tile (Bezalel-style) */}
          {!collapsed ? (
            <div className="pt-1.5 mt-1 border-t border-[var(--sidebar-border)] flex items-center gap-2 px-1 text-xs">
              <span className="size-2 rounded-full bg-[#15803d] shrink-0" />
              <span className="font-mono text-[11px] text-[var(--muted-foreground)] truncate">
                Operator: Local Dev
              </span>
            </div>
          ) : (
            <Tooltip content="Operator: Local Dev (Connected)" side="right">
              <div className="flex items-center justify-center p-1.5">
                <span className="size-2 rounded-full bg-[#15803d]" />
              </div>
            </Tooltip>
          )}
        </div>
      </div>
    </aside>
  );
}

