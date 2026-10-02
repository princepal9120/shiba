/**
 * SettingsView — two-pane settings shell in the app's Retro Paper-OS style:
 * a left subnav (data-driven — new sections slot into SETTINGS_SECTIONS) and
 * a content pane that mounts the REAL surfaces (MemoryTab, /api/setup/status,
 * /api/agents, /api/auth/*) rather than duplicating their internals. Sections
 * with no real data source are omitted, not stubbed.
 */
import { useMemo, useState, type JSX, type ReactNode } from "react";
import { version as dashboardVersion } from "../../package.json";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { MemoryTab } from "./MemoryTab";
import { ToneChip } from "./ToneChip";
import {
  PROVIDER_AUTH_LANES,
  authPhaseLabel,
  authPhaseTone,
  useAgentsDirectory,
  useProviderAuth,
  useSetupStatus,
  type ProviderAuthLane,
  type SetupStatus,
} from "../live-status";

type SettingsSectionId =
  | "providers"
  | "environments"
  | "memory"
  | "guidance"
  | "experimental"
  | "deployment";

const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; blurb: string }[] = [
  { id: "providers", label: "Providers", blurb: "Subscription lanes & agent credentials" },
  { id: "environments", label: "Environments", blurb: "Deployment configuration the Worker proves" },
  { id: "memory", label: "Memory", blurb: "Vectorize long-term semantic memory" },
  { id: "guidance", label: "Agent guidance", blurb: "MCP principals & capability scopes" },
  { id: "experimental", label: "Experimental", blurb: "Opt-in feature flags (wrangler vars)" },
  { id: "deployment", label: "Deployment", blurb: "Serving host, models & harness" },
];

function SectionShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h3 className="text-sm font-semibold text-[#222320]">{title}</h3>
        <p className="mt-0.5 text-xs text-[#6a6f63]">{description}</p>
      </div>
      {children}
    </section>
  );
}

function Card({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[2px_2px_0_var(--paper-shadow)]">
      {children}
    </div>
  );
}

/** One row of the environments checklist: a label, a proven boolean, and a detail line. */
function ChecklistRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }): JSX.Element {
  return (
    <div className="flex items-start gap-2.5 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0">
      <span
        aria-hidden="true"
        className={`mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-none border text-[10px] font-bold ${
          ok
            ? "border-[#15803d]/40 bg-[#15803d]/10 text-[#15803d]"
            : "border-[#d3d2c8] bg-[#e0ded5]/60 text-[#6a6f63]"
        }`}
      >
        {ok ? "✓" : "·"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-[#222320]">{label}</div>
        <div className="font-mono text-[11px] text-[#6a6f63]">{detail}</div>
      </div>
    </div>
  );
}

function ProviderLaneRow({ lane }: { lane: ProviderAuthLane }): JSX.Element {
  const { state } = useProviderAuth(lane.apiBase);
  return (
    <div className="flex flex-col gap-1.5 border-b border-[#e0ded5] px-4 py-3 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-[#222320]">{lane.label}</div>
        <div className="font-mono text-[11px] text-[#6a6f63]">
          {lane.flag} · {lane.credentialLabel}
        </div>
        {state.kind === "snapshot" && state.snapshot.message ? (
          <div className="mt-0.5 text-[11px] text-[#6a6f63]">{state.snapshot.message}</div>
        ) : null}
        {state.kind === "error" ? (
          <div className="mt-0.5 text-[11px] text-[#b91c1c]">{state.message}</div>
        ) : null}
      </div>
      <ToneChip tone={authPhaseTone(state)} label={authPhaseLabel(state)} />
    </div>
  );
}

function EnvironmentsSection({ status }: { status: SetupStatus | undefined }): JSX.Element {
  if (!status) {
    return <Card><div className="px-4 py-6 text-center text-xs text-[#6a6f63]">Reading /api/setup/status…</div></Card>;
  }
  return (
    <Card>
      <ChecklistRow label="Slack signing secret" ok={status.slack.signingSecret} detail="SLACK_SIGNING_SECRET — verifies Slack callbacks" />
      <ChecklistRow label="Slack bot token" ok={status.slack.botToken} detail="SLACK_BOT_TOKEN — posts approval cards" />
      <ChecklistRow label="Slack approvers" ok={status.slack.approvers > 0} detail={`SLACK_APPROVERS — ${status.slack.approvers} configured`} />
      <ChecklistRow label="Slack channel→repo map" ok={status.slack.channelRepos} detail="SLACK_CHANNEL_REPOS — repo for bare mentions" />
      <ChecklistRow label="GitHub token" ok={status.github.token} detail="GITHUB_TOKEN — opens pull requests" />
      <ChecklistRow label="GitHub webhook secret" ok={status.github.webhookSecret} detail="GITHUB_WEBHOOK_SECRET — verifies deliveries" />
      <ChecklistRow label="AI Gateway token" ok={status.gateway.token} detail="AI_GATEWAY_TOKEN — BYOK provider egress" />
      <ChecklistRow label="AI Gateway reachable" ok={status.gateway.reachable === "yes"} detail={`gateway "${status.gateway.id}" — ${status.gateway.reachable}`} />
      <ChecklistRow label="Cloudflare Access required" ok={status.access.required} detail="REQUIRE_ACCESS / ACCESS_AUD — identity on every path" />
      <ChecklistRow label="Automations enabled" ok={status.automations.enabled} detail="AUTOMATIONS_ENABLED kill switch" />
      <ChecklistRow label="TypeSafe key" ok={status.automations.typeSafe} detail="TYPESAFE_API_KEY — System One judgments" />
    </Card>
  );
}

/** Static copy of the opt-in flags from wrangler.jsonc's vars comment block + env.ts. */
const EXPERIMENTAL_FLAGS: { flag: string; effect: string; related: string }[] = [
  {
    flag: "SHIBA_CLAUDE_SUBSCRIPTION=1",
    effect: "Registers the claude-subscription harness (T48).",
    related: "CLAUDE_SUBSCRIPTION_MODEL · CLAUDE_SUBSCRIPTION_TOKEN[_<ACCOUNT>] secret",
  },
  {
    flag: "SHIBA_CODEX_SUBSCRIPTION=1",
    effect: "Registers the codex-subscription harness (T49).",
    related: "CODEX_SUBSCRIPTION_MODEL · CODEX_SUBSCRIPTION_AUTH_JSON[_<ACCOUNT>] secret",
  },
  {
    flag: "SHIBA_ANTIGRAVITY_SUBSCRIPTION=1",
    effect: "Registers antigravity-subscription + /api/antigravity/callback (T50 pasted-redirect OAuth).",
    related: "ANTIGRAVITY_SUBSCRIPTION_MODEL — no secret var (tokens live in the container profile)",
  },
  {
    flag: "SHIBA_LOCAL_RUNTIME=1",
    effect: "Admits runtime:\"local\" at intake and opens the /api/local daemon surface (T51).",
    related: "LOCAL_ADAPTER_TOKEN secret — unset = the surface refuses every request",
  },
];

const KILL_SWITCHES: { flag: string; effect: string }[] = [
  { flag: "AUTOMATIONS_ENABLED", effect: "\"false\"/\"0\"/\"off\" stops every automation firing." },
  { flag: "MEMORY_ENABLED", effect: "\"false\"/\"0\"/\"off\" disables run-end distillation into Memory — never the run." },
];

export function SettingsView({
  onNavigate,
}: {
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const [section, setSection] = useState<SettingsSectionId>("providers");
  const directory = useAgentsDirectory();
  const setup = useSetupStatus();

  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const principals = directory.state.kind === "data" ? directory.state.data.principals : undefined;
  const secretCredentials = useMemo(
    () =>
      (directory.state.kind === "data" ? directory.state.data.agents : []).filter(
        (entry) => entry.credential.kind !== "ai-gateway-byok",
      ),
    [directory.state],
  );

  const hostname = typeof window !== "undefined" ? window.location.hostname : "";

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Settings</span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Deployment configuration and operator surfaces — read-only mirrors of what the Worker reports.
          </p>
        </div>
      </div>
      <div className="flex-1 flex min-h-0">
        {/* Left subnav — data-driven; add a section object to slot a new pane in. */}
        <nav
          aria-label="Settings"
          className="w-44 lg:w-52 shrink-0 overflow-y-auto border-r border-[#e0ded5] bg-[#f6f4ed] py-3 px-2.5"
        >
          <div className="flex flex-col gap-0.5">
            {SETTINGS_SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSection(entry.id)}
                aria-current={section === entry.id ? "page" : undefined}
                className={
                  "w-full rounded-none px-2.5 py-2 text-left transition-colors duration-100 " +
                  (section === entry.id
                    ? "bg-[#0000a8] text-white shadow-[2px_2px_0_var(--paper-shadow)]"
                    : "text-[#222320] hover:bg-[#e0ded5]")
                }
              >
                <span className="block text-[13px] font-medium">{entry.label}</span>
                <span
                  className={
                    "mt-0.5 block text-[10px] leading-snug " +
                    (section === entry.id ? "text-white/80" : "text-[#6a6f63]")
                  }
                >
                  {entry.blurb}
                </span>
              </button>
            ))}
          </div>
        </nav>

        {/* Content pane */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-8">
          <div className="max-w-3xl mx-auto">
            {section === "providers" ? (
              <SectionShell
                title="Providers"
                description="Subscription-auth lanes and credential state. Connect/disconnect flows live in Agents & MCP."
              >
                <Card>
                  {PROVIDER_AUTH_LANES.map((lane) => (
                    <ProviderLaneRow key={lane.id} lane={lane} />
                  ))}
                </Card>
                <Card>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
                    Secret-backed credentials (from /api/agents)
                  </div>
                  {secretCredentials.length === 0 ? (
                    <div className="px-4 py-5 text-center text-xs text-[#6a6f63]">
                      {directory.state.kind === "loading"
                        ? "Loading catalog…"
                        : "No secret-backed credentials in this deployment's catalog."}
                    </div>
                  ) : (
                    secretCredentials.map((entry) => (
                      <div key={entry.id} className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[#222320]">{entry.label}</div>
                          <div className="font-mono text-[11px] text-[#6a6f63]">{entry.credential.label}</div>
                          {entry.credential.configured === false && entry.credential.setupHint ? (
                            <div className="mt-0.5 font-mono text-[11px] text-[#b45309]">{entry.credential.setupHint}</div>
                          ) : null}
                        </div>
                        <ToneChip
                          tone={entry.credential.configured === true ? "ok" : entry.credential.configured === false ? "danger" : "neutral"}
                          label={
                            entry.credential.configured === true
                              ? "Configured"
                              : entry.credential.configured === false
                                ? "Missing secret"
                                : "Not introspectable"
                          }
                        />
                      </div>
                    ))
                  )}
                </Card>
                {onNavigate ? (
                  <button
                    type="button"
                    onClick={() => onNavigate("agents")}
                    className="self-start text-xs font-semibold text-[#1c1cc8] transition-colors hover:text-[#0000a8]"
                  >
                    Manage agents & MCP →
                  </button>
                ) : null}
              </SectionShell>
            ) : section === "environments" ? (
              <SectionShell
                title="Environments"
                description="Configuration the deployment itself proves — every row is a boolean from GET /api/setup/status."
              >
                {setup.state.kind === "error" ? (
                  <LoadErrorState message={setup.state.message} onRetry={setup.reload} />
                ) : (
                  <EnvironmentsSection status={status} />
                )}
              </SectionShell>
            ) : section === "memory" ? (
              <SectionShell
                title="Memory"
                description="Long-term semantic memory — the same MemoryTab mounted in the Memory view."
              >
                <MemoryTab />
              </SectionShell>
            ) : section === "guidance" ? (
              <SectionShell
                title="Agent guidance"
                description="Registered MCP-token principals and their capability scopes (read-only — managed in Agents & MCP)."
              >
                <Card>
                  {principals === undefined ? (
                    <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
                      {directory.state.kind === "error" ? "Could not load /api/agents." : "Loading principals…"}
                    </div>
                  ) : principals.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
                      No MCP-token principals registered.
                    </div>
                  ) : (
                    principals.map((principal) => (
                      <div key={principal.principal} className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0">
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[#222320]">{principal.principal}</div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {principal.scopes.map((scope) => (
                              <span key={scope} className="rounded-none border border-[#e0ded5] bg-[#f6f4ed] px-1.5 py-px font-mono text-[10px] text-[#6a6f63]">
                                {scope}
                              </span>
                            ))}
                          </div>
                        </div>
                        <ToneChip tone={principal.live ? "ok" : "neutral"} label={principal.live ? "Live" : "Revoked"} />
                      </div>
                    ))
                  )}
                </Card>
                {onNavigate ? (
                  <button
                    type="button"
                    onClick={() => onNavigate("agents")}
                    className="self-start text-xs font-semibold text-[#1c1cc8] transition-colors hover:text-[#0000a8]"
                  >
                    Open Agents & MCP →
                  </button>
                ) : null}
              </SectionShell>
            ) : section === "experimental" ? (
              <SectionShell
                title="Experimental"
                description="Opt-in feature flags. These are set via wrangler vars/secrets at deploy time — this list mirrors wrangler.jsonc's vars comment block; it cannot read live values."
              >
                <Card>
                  {EXPERIMENTAL_FLAGS.map((flag) => (
                    <div key={flag.flag} className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
                      <div className="font-mono text-xs font-semibold text-[#1c1cc8]">{flag.flag}</div>
                      <div className="mt-0.5 text-xs text-[#222320]">{flag.effect}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-[#6a6f63]">{flag.related}</div>
                    </div>
                  ))}
                </Card>
                <Card>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
                    Kill switches (env.ts)
                  </div>
                  {KILL_SWITCHES.map((flag) => (
                    <div key={flag.flag} className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
                      <div className="font-mono text-xs font-semibold text-[#1c1cc8]">{flag.flag}</div>
                      <div className="mt-0.5 text-xs text-[#222320]">{flag.effect}</div>
                    </div>
                  ))}
                </Card>
              </SectionShell>
            ) : (
              <SectionShell
                title="Deployment"
                description="What this dashboard is served by — the Worker serving this page is the deployment."
              >
                <Card>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5">
                    <div className="text-xs font-medium text-[#222320]">Serving host</div>
                    <div className="font-mono text-[11px] text-[#6a6f63]">{hostname || "unknown"}</div>
                  </div>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5">
                    <div className="text-xs font-medium text-[#222320]">Dashboard package</div>
                    <div className="font-mono text-[11px] text-[#6a6f63]">@shiba/frontend@{dashboardVersion}</div>
                  </div>
                  {status ? (
                    <>
                      <div className="border-b border-[#e0ded5] px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">Orchestrator model</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">{status.models.orchestrator}</div>
                      </div>
                      <div className="border-b border-[#e0ded5] px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">Coding model</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">{status.models.coding}</div>
                      </div>
                      <div className="border-b border-[#e0ded5] px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">Default harness</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">{status.models.harness}</div>
                      </div>
                      <div className="px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">AI Gateway</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">
                          {status.gateway.id} · {status.gateway.reachable}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="px-4 py-2.5 text-xs text-[#6a6f63]">
                      {setup.state.kind === "error" ? "Model details unavailable — /api/setup/status failed." : "Reading /api/setup/status…"}
                    </div>
                  )}
                </Card>
              </SectionShell>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
