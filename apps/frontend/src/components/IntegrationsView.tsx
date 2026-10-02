/**
 * IntegrationsView — the product's wired surfaces in one Roomote-style
 * registry: provider subscription lanes, chat/approval channels, the
 * mailbox, and platform services. Every row is backed by a real API read
 * (`/api/agents`, `/api/setup/status`, `/api/mailboxes`, `/api/auth/*`) or
 * carries an honest "operator provisioned" line — no fake toggles.
 */
import { useMemo, type JSX, type ReactNode } from "react";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { ToneChip } from "./ToneChip";
import {
  PROVIDER_AUTH_LANES,
  authPhaseLabel,
  authPhaseTone,
  useAgentsDirectory,
  useMailboxes,
  useProviderAuth,
  useSetupStatus,
  type AgentCliEntry,
  type ProviderAuthLane,
  type ProviderAuthState,
  type SetupStatus,
} from "../live-status";

function IntegrationRow({
  name,
  status,
  children,
  action,
}: {
  name: string;
  status: ReactNode;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2 border-b border-[#e0ded5] px-4 py-3.5 last:border-b-0 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[13px] font-semibold text-[#222320]">{name}</span>
          {status}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-[#6a6f63]">{children}</div>
      </div>
      {action ? (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 self-start rounded-none border border-[#e0ded5] bg-[#fffef8] px-2.5 py-1 text-[11px] font-mono font-medium text-[#1c1cc8] transition-colors hover:border-[#0000a8]/40 hover:bg-[#0000a8]/5 sm:self-center"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

function IntegrationGroup({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section>
      <p className="mb-1 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
        {title}
      </p>
      <p className="mb-2 text-xs text-[#6a6f63]">{hint}</p>
      <div className="rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[2px_2px_0_var(--paper-shadow)]">
        {children}
      </div>
    </section>
  );
}

/** The catalog row for a harness id, when the deployment registered it. */
function catalogEntry(agents: AgentCliEntry[] | undefined, id: string): AgentCliEntry | undefined {
  return agents?.find((entry) => entry.id === id);
}

/** Chip describing a catalog credential — worker-secret presence is observable, BYOK is not. */
function credentialChip(entry: AgentCliEntry | undefined): JSX.Element {
  if (!entry) return <ToneChip tone="neutral" label="Not registered" />;
  const { credential } = entry;
  if (credential.kind === "worker-secret") {
    return credential.configured === true ? (
      <ToneChip tone="ok" label="Configured" />
    ) : credential.configured === false ? (
      <ToneChip tone="danger" label="Missing secret" />
    ) : (
      <ToneChip tone="neutral" label="Not introspectable" />
    );
  }
  if (credential.kind === "oauth-signin") {
    return <ToneChip tone="neutral" label="In-container OAuth" />;
  }
  return <ToneChip tone="navy" label="AI Gateway BYOK" />;
}

function authChip(state: ProviderAuthState): JSX.Element {
  return <ToneChip tone={authPhaseTone(state)} label={authPhaseLabel(state)} />;
}

/** One subscription lane (Claude / Codex / Antigravity): live auth snapshot + catalog metadata. */
function SubscriptionLaneRow({
  lane,
  agents,
  catalogIds,
}: {
  lane: ProviderAuthLane;
  agents: AgentCliEntry[] | undefined;
  catalogIds: string[];
}): JSX.Element {
  const { state } = useProviderAuth(lane.apiBase);
  const entries = catalogIds
    .map((id) => catalogEntry(agents, id))
    .filter((entry): entry is AgentCliEntry => entry !== undefined);
  return (
    <IntegrationRow name={lane.label} status={authChip(state)}>
      <p>{lane.blurb}</p>
      <p className="mt-0.5 font-mono text-[11px]">
        {lane.flag} · {lane.credentialLabel} · {lane.apiBase}
      </p>
      {entries.length > 0 ? (
        <p className="mt-0.5 font-mono text-[11px]">
          {entries.map((entry) => `${entry.binary}@${entry.version}`).join(" · ")}
        </p>
      ) : null}
      {state.kind === "snapshot" && state.snapshot.message ? (
        <p className="mt-0.5 text-[11px]">{state.snapshot.message}</p>
      ) : null}
      {state.kind === "snapshot" && state.snapshot.expiresAt !== undefined ? (
        <p className="mt-0.5 text-[11px]">
          Credential valid until {new Date(state.snapshot.expiresAt).toLocaleDateString()}.
        </p>
      ) : null}
      {state.kind === "error" ? <p className="mt-0.5 text-[11px] text-[#b91c1c]">{state.message}</p> : null}
    </IntegrationRow>
  );
}

function slackChip(slack: SetupStatus["slack"] | undefined): JSX.Element {
  if (!slack) return <ToneChip tone="neutral" label="Checking…" />;
  const configured = slack.signingSecret && slack.botToken && slack.approvers > 0;
  const partial = slack.signingSecret || slack.botToken || slack.approvers > 0 || slack.channelRepos;
  if (configured) return <ToneChip tone="ok" label="Configured" />;
  if (partial) return <ToneChip tone="pending" label="Partial" />;
  return <ToneChip tone="neutral" label="Not configured" />;
}

function githubChip(github: SetupStatus["github"] | undefined): JSX.Element {
  if (!github) return <ToneChip tone="neutral" label="Checking…" />;
  if (github.token && github.webhookSecret) return <ToneChip tone="ok" label="Configured" />;
  if (github.token || github.webhookSecret) return <ToneChip tone="pending" label="Partial" />;
  return <ToneChip tone="neutral" label="Not configured" />;
}

function gatewayChip(gateway: SetupStatus["gateway"] | undefined): JSX.Element {
  if (!gateway) return <ToneChip tone="neutral" label="Checking…" />;
  switch (gateway.reachable) {
    case "yes":
      return <ToneChip tone="ok" label="Reachable" />;
    case "unauthorized":
      return <ToneChip tone="danger" label="Unauthorized" />;
    case "error":
      return <ToneChip tone="danger" label="Unreachable" />;
    default:
      return <ToneChip tone="neutral" label="Unknown" />;
  }
}

export function IntegrationsView({
  onNavigate,
}: {
  onNavigate?: (view: AppNavView) => void;
}): JSX.Element {
  const directory = useAgentsDirectory();
  const setup = useSetupStatus();
  const mailboxes = useMailboxes();

  const agents = directory.state.kind === "data" ? directory.state.data.agents : undefined;
  const principals = directory.state.kind === "data" ? directory.state.data.principals : undefined;
  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;

  const livePrincipals = useMemo(
    () => (principals ?? []).filter((principal) => principal.live),
    [principals],
  );

  const failed =
    directory.state.kind === "error" ? directory.state : setup.state.kind === "error" ? setup.state : null;
  const reloadAll = () => {
    directory.reload();
    setup.reload();
    mailboxes.reload();
  };

  const catalogRows = agents ?? [];
  const cursor = catalogEntry(agents, "cursor");
  const devin = catalogEntry(agents, "devin");

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 shrink-0 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Integrations</span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Providers, channels, and platform services wired into this deployment — status is what the Worker can prove.
          </p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          {failed ? <LoadErrorState message={failed.message} onRetry={reloadAll} /> : null}

          <IntegrationGroup
            title="Provider subscription lanes"
            hint="Subscription-backed coding agents. Connect/disconnect lives in Agents & MCP; this surface reports the live auth phase."
          >
            {PROVIDER_AUTH_LANES.map((lane) => (
              <SubscriptionLaneRow
                key={lane.id}
                lane={lane}
                agents={agents}
                catalogIds={
                  lane.id === "claude-subscription"
                    ? ["claude-subscription", "claude-code"]
                    : lane.id === "codex-subscription"
                      ? ["codex-subscription", "codex"]
                      : ["antigravity-subscription", "antigravity"]
                }
              />
            ))}
            <IntegrationRow name="Cursor" status={credentialChip(cursor)}>
              <p>Cursor Agent CLI (<span className="font-mono">cursor-agent</span>) in ACP mode.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                AI Gateway BYOK (cursor) · api2.cursor.sh — the key lives at the gateway; no /api/auth route exists.
              </p>
              {cursor ? (
                <p className="mt-0.5 font-mono text-[11px]">
                  {cursor.binary}@{cursor.version} · default model {cursor.defaultModel}
                </p>
              ) : null}
            </IntegrationRow>
            <IntegrationRow name="Devin" status={credentialChip(devin)}>
              <p>Devin CLI harness — SWE agent runs through the Devin API.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                DEVIN_API_KEY worker secret · injected at egress on api.devin.ai, never inside the container.
              </p>
              {devin ? (
                <p className="mt-0.5 font-mono text-[11px]">
                  {devin.binary}@{devin.version} · default model {devin.defaultModel}
                </p>
              ) : null}
              {devin?.credential.configured === false && devin.credential.setupHint ? (
                <p className="mt-0.5 font-mono text-[11px] text-[#b45309]">{devin.credential.setupHint}</p>
              ) : null}
            </IntegrationRow>
          </IntegrationGroup>

          <IntegrationGroup
            title="Sandboxed agent CLIs"
            hint="The harness catalog this deployment registered — GET /api/agents, verbatim."
          >
            {catalogRows.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
                {directory.state.kind === "loading" ? "Loading catalog…" : "No harnesses registered."}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-[#e0ded5] text-[10px] font-mono uppercase tracking-[0.1em] text-[#6a6f63]">
                      <th className="px-4 py-2 font-semibold">Harness</th>
                      <th className="px-4 py-2 font-semibold">Binary</th>
                      <th className="px-4 py-2 font-semibold">Default model</th>
                      <th className="px-4 py-2 font-semibold">Credential</th>
                    </tr>
                  </thead>
                  <tbody>
                    {catalogRows.map((entry) => (
                      <tr key={entry.id} className="border-b border-[#e0ded5]/60 last:border-b-0">
                        <td className="px-4 py-2 font-medium text-[#222320]">
                          {entry.label}
                          <span className="ml-1.5 font-mono text-[10px] text-[#6a6f63]">{entry.id}</span>
                        </td>
                        <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">
                          {entry.binary}@{entry.version}
                        </td>
                        <td className="px-4 py-2 font-mono text-[11px] text-[#6a6f63]">{entry.defaultModel}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            {credentialChip(entry)}
                            <span className="font-mono text-[10px] text-[#6a6f63]">{entry.credential.label}</span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </IntegrationGroup>

          <IntegrationGroup
            title="Chat & approval channels"
            hint="Surfaces humans use to queue and approve runs. Webhook receivers are provisioned via wrangler secrets — the dashboard cannot introspect them."
          >
            <IntegrationRow name="Slack" status={slackChip(status?.slack)}>
              <p>Slash commands, mention events, and approval cards resolved inside Slack.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                /api/slack/events · /api/slack/command · /api/slack/interact
              </p>
              {status ? (
                <p className="mt-0.5 font-mono text-[11px]">
                  signing secret {status.slack.signingSecret ? "set" : "unset"} · bot token{" "}
                  {status.slack.botToken ? "set" : "unset"} · {status.slack.approvers} approver
                  {status.slack.approvers === 1 ? "" : "s"} · channel→repo map{" "}
                  {status.slack.channelRepos ? "set" : "unset"}
                </p>
              ) : null}
            </IntegrationRow>
            <IntegrationRow name="Telegram" status={<ToneChip tone="neutral" label="External" />}>
              <p>Telegram bot webhook for task intake and approvals.</p>
              <p className="mt-0.5 font-mono text-[11px]">POST /api/telegram/webhook</p>
              <p className="mt-0.5 font-mono text-[11px]">
                Operator provisioned: TELEGRAM_BOT_TOKEN / TELEGRAM_WEBHOOK_SECRET / TELEGRAM_APPROVERS — no status route exists.
              </p>
            </IntegrationRow>
            <IntegrationRow name="Discord" status={<ToneChip tone="neutral" label="External" />}>
              <p>Discord interactions endpoint for run commands and progress posts.</p>
              <p className="mt-0.5 font-mono text-[11px]">POST /api/discord/interactions</p>
              <p className="mt-0.5 font-mono text-[11px]">
                Operator provisioned: DISCORD_PUBLIC_KEY / DISCORD_BOT_TOKEN / DISCORD_APPROVERS — no status route exists.
              </p>
            </IntegrationRow>
          </IntegrationGroup>

          <IntegrationGroup
            title="Email"
            hint="Cloudflare Email Routing inbound and approval-gated outbound."
          >
            <IntegrationRow
              name="Mailbox / Email Routing"
              status={
                mailboxList === undefined ? (
                  <ToneChip tone="neutral" label={mailboxes.state.kind === "error" ? "Status error" : "Checking…"} />
                ) : mailboxList.length > 0 ? (
                  <ToneChip tone="ok" label={`${mailboxList.length} registered`} />
                ) : (
                  <ToneChip tone="neutral" label="None registered" />
                )
              }
              action={onNavigate ? { label: "Open Mailbox →", onClick: () => onNavigate("inbox") } : undefined}
            >
              <p>Inbound triage and drafts in the Mailbox view; outbound sends queue behind a human approval.</p>
              {mailboxList && mailboxList.length > 0 ? (
                <p className="mt-0.5 font-mono text-[11px]">
                  {mailboxList
                    .slice(0, 4)
                    .map((mailbox) => mailbox.address)
                    .join(" · ")}
                  {mailboxList.length > 4 ? ` · +${mailboxList.length - 4} more` : ""}
                </p>
              ) : null}
            </IntegrationRow>
          </IntegrationGroup>

          <IntegrationGroup
            title="Platform services"
            hint="Worker-level integrations the product itself consumes."
          >
            <IntegrationRow
              name="MCP gateway"
              status={
                principals === undefined ? (
                  <ToneChip tone="neutral" label={directory.state.kind === "error" ? "Status error" : "Checking…"} />
                ) : livePrincipals.length > 0 ? (
                  <ToneChip tone="ok" label={`${livePrincipals.length} live`} />
                ) : (
                  <ToneChip tone="neutral" label="No live principals" />
                )
              }
              action={onNavigate ? { label: "Open Agents →", onClick: () => onNavigate("agents") } : undefined}
            >
              <p>Bearer-token MCP endpoint — run tools, memory tools, and email tools for external agents.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                /mcp · {principals?.length ?? 0} principal{(principals?.length ?? 0) === 1 ? "" : "s"} registered
                {livePrincipals.length > 0 ? ` · ${livePrincipals.length} with live tokens` : ""}
              </p>
            </IntegrationRow>
            <IntegrationRow name="GitHub" status={githubChip(status?.github)}>
              <p>Pull-request publishing plus HMAC-verified webhook deliveries.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                GITHUB_TOKEN {status?.github.token ? "set" : "unset"} · /api/github/webhook (GITHUB_WEBHOOK_SECRET{" "}
                {status?.github.webhookSecret ? "set" : "unset"})
              </p>
            </IntegrationRow>
            <IntegrationRow name="AI Gateway" status={gatewayChip(status?.gateway)}>
              <p>BYOK provider egress — harness keys stay at the gateway, never in containers.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                gateway “{status?.gateway.id ?? "…"}” · AI_GATEWAY_TOKEN{" "}
                {status ? (status.gateway.token ? "set" : "unset") : "…"}
              </p>
            </IntegrationRow>
            <IntegrationRow name="Automations engine" status={
              status === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : status.automations.enabled ? (
                <ToneChip tone="ok" label="Enabled" />
              ) : (
                <ToneChip tone="neutral" label="Disabled" />
              )
            }
              action={onNavigate ? { label: "Open Automations →", onClick: () => onNavigate("automations") } : undefined}
            >
              <p>Scheduled and webhook-triggered automations from the Automations DO.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                AUTOMATIONS_ENABLED · TypeSafe judgments{" "}
                {status ? (status.automations.typeSafe ? "armed" : "unarmed") : "…"}
              </p>
            </IntegrationRow>
            <IntegrationRow name="Trigger webhook" status={<ToneChip tone="neutral" label="External" />}>
              <p>Authenticated POST endpoint for external clients (e.g. phone shortcuts) to queue approvals.</p>
              <p className="mt-0.5 font-mono text-[11px]">
                POST /api/trigger · operator provisioned: TRIGGER_TOKEN — no status route exists.
              </p>
            </IntegrationRow>
            <IntegrationRow name="Local runtime" status={<ToneChip tone="neutral" label="External" />}>
              <p>Optional operator daemon that runs sandbox work on a local machine (T51).</p>
              <p className="mt-0.5 font-mono text-[11px]">
                /api/local/* · operator provisioned: SHIBA_LOCAL_RUNTIME + LOCAL_ADAPTER_TOKEN — no status route exists.
              </p>
            </IntegrationRow>
          </IntegrationGroup>
        </div>
      </div>
    </div>
  );
}
