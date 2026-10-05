/**
 * SettingsView — two-pane settings shell in the app's Retro Paper-OS style:
 * a left subnav (data-driven — new sections slot into SETTINGS_SECTIONS) and
 * a content pane that mounts the REAL surfaces (MemoryTab, /api/setup/status,
 * /api/agents, /api/auth/*) rather than duplicating their internals. Sections
 * with no real data source are omitted, not stubbed.
 */
import { type JSX, type ReactNode, useMemo, useState } from "react";
import { version as dashboardVersion } from "../../package.json";
import {
  type AgentCliEntry,
  type RoleModelWire,
  type SetupStatus,
  useAgentsDirectory,
  useModelConfig,
  useSetupStatus,
} from "../live-status";
import type { AppNavView } from "./AppNavRail";
import { LoadErrorState } from "./LoadErrorState";
import { MemoryTab } from "./MemoryTab";
import {
  SUBSCRIPTION_AUTH,
  SubscriptionConnect,
  type SubscriptionId,
  type SubscriptionStatus,
  subscriptionChip,
} from "./SubscriptionConnect";
import { ToneChip } from "./ToneChip";
import { useSavedRepos, saveRepo, removeRepo } from "../saved";

type SettingsSectionId =
  | "repositories"
  | "providers"
  | "models"
  | "environments"
  | "memory"
  | "guidance"
  | "experimental"
  | "deployment";

const SETTINGS_SECTIONS: { id: SettingsSectionId; label: string; blurb: string }[] = [
  { id: "repositories", label: "Repositories", blurb: "Saved GitHub targets" },
  { id: "providers", label: "Providers", blurb: "Your AI agents" },
  { id: "models", label: "Models", blurb: "Per-role agent routing" },
  {
    id: "environments",
    label: "Environments",
    blurb: "Deployment configuration the Worker proves",
  },
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
function ChecklistRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}): JSX.Element {
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

function ProviderLaneRow({
  id,
  agents,
}: {
  id: SubscriptionId;
  agents: AgentCliEntry[];
}): JSX.Element {
  const spec = SUBSCRIPTION_AUTH[id];
  const credential = agents.find((entry) => entry.id === id)?.credential ?? spec.credential;
  const [status, setStatus] = useState<SubscriptionStatus>({ kind: "loading" });
  return (
    <div className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-[#222320]">{spec.label}</div>
          <div className="text-[11px] text-[#6a6f63]">{spec.blurb}</div>
        </div>
        {subscriptionChip(status)}
      </div>
      <SubscriptionConnect spec={spec} credential={credential} onStatus={setStatus} />
    </div>
  );
}

const ROLE_SOURCE_LABEL: Record<RoleModelWire["source"], string> = {
  "role-map": "ROLE_MODEL_MAP",
  "role-env": "ROLE_MODEL__",
  default: "Deployment default",
};

/**
 * One role row of the Models section: a read-only harness picker (the live
 * /api/agents catalog) plus the model the backend resolved for that role.
 * Values are env-driven — the row shows where to set them, never a form.
 */
function RoleModelRow({
  row,
  agents,
}: {
  row: RoleModelWire;
  agents: AgentCliEntry[];
}): JSX.Element {
  const roleVar = `ROLE_MODEL__${row.role.toUpperCase()}`;
  const options =
    row.harness === "" || agents.some((a) => a.id === row.harness)
      ? agents
      : [...agents, { id: row.harness, label: row.harness } as AgentCliEntry];
  return (
    <div className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-[#222320]">{row.role}</div>
        <ToneChip
          tone={row.error ? "danger" : row.source === "default" ? "neutral" : "navy"}
          label={
            row.error
              ? "Pin error"
              : row.source === "role-env"
                ? roleVar
                : ROLE_SOURCE_LABEL[row.source]
          }
        />
      </div>
      <div className="mt-2 flex flex-col gap-2 sm:flex-row">
        <select
          disabled
          value={row.harness}
          aria-label={`${row.role} harness`}
          className="bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs font-medium disabled:opacity-80 disabled:cursor-not-allowed sm:w-56"
        >
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <input
          readOnly
          value={row.model}
          aria-label={`${row.role} model`}
          spellCheck={false}
          className="flex-1 bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs font-mono read-only:opacity-80"
        />
      </div>
      {row.error ? <div className="mt-1.5 text-[11px] text-[#b91c1c]">{row.error}</div> : null}
      <div className="mt-1.5 font-mono text-[11px] text-[#6a6f63]">
        set via ROLE_MODEL_MAP["{row.role}"] or {roleVar}
      </div>
    </div>
  );
}

function ModelsSection({
  status,
  agents,
}: {
  status: SetupStatus | undefined;
  agents: AgentCliEntry[];
}): JSX.Element {
  if (!status) {
    return (
      <Card>
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          Reading /api/setup/status…
        </div>
      </Card>
    );
  }
  const rows = status.models.roles ?? [];
  return (
    <>
      <Card>
        {rows.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
            This deployment doesn't report per-role routing — update the backend.
          </div>
        ) : (
          rows.map((row) => <RoleModelRow key={row.role} row={row} agents={agents} />)
        )}
      </Card>
      <Card>
        <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
          How to pin a role (wrangler vars / secrets at deploy time)
        </div>
        <div className="px-4 py-3 flex flex-col gap-2">
          <div className="font-mono text-[11px] leading-relaxed text-[#222320] break-all">
            ROLE_MODEL_MAP={'{"fixer":{"harness":"opencode","model":"opencode-go/deepseek-v3.2"}}'}
          </div>
          <div className="font-mono text-[11px] leading-relaxed text-[#222320] break-all">
            ROLE_MODEL__REVIEWER="claude-subscription/anthropic-subscription/claude-sonnet-4-6"
          </div>
          <div className="text-xs text-[#6a6f63]">
            One JSON map, or a per-role {"<harness>/<provider>/<model>"} var (model optional — the
            harness's own *_MODEL var, then its catalog default, fills it in). An unpinned role
            resolves to the deployment default chain (AGENT_HARNESS, then opencode).
          </div>
        </div>
      </Card>
      <PurposeRoutingCard />
      <ConnectionsCard />
    </>
  );
}

/** Purposes the policy can point at a Workers AI model — the rest are fixed. */
const EDITABLE_PURPOSES: { id: string; label: string; hint: string }[] = [
  { id: "orchestrator", label: "Orchestrator", hint: "The parent agent that plans and delegates" },
  { id: "automation_gate", label: "Automation gate", hint: "Decides whether an automation fires" },
  { id: "distillation", label: "Distillation", hint: "Compresses finished runs into Memory" },
];

const FIXED_PURPOSES: { id: string; label: string; note: string }[] = [
  { id: "intent", label: "Intent", note: "TypeSafe judgment — no model to pick" },
  { id: "quality", label: "Quality", note: "TypeSafe judgment — no model to pick" },
  { id: "coding", label: "Coding", note: "Picked per task in the composer (provider/model)" },
];

const CONNECTION_SERVICES = [
  "anthropic",
  "openai",
  "google",
  "devin",
  "opencode-go",
  "cursor",
] as const;

/** Purpose routing — which model does each internal job. Edits save to /api/model-config/policy. */
function PurposeRoutingCard(): JSX.Element {
  const { state, reload } = useModelConfig();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const policyModels = state.kind === "data" ? state.data.policy.models : {};
  const value = (purpose: string) => (draft ? (draft[purpose] ?? "") : (policyModels[purpose] ?? ""));

  const save = async () => {
    setSaving(true);
    setFeedback(null);
    try {
      const models: Record<string, string> = {};
      for (const purpose of EDITABLE_PURPOSES) {
        const model = value(purpose.id).trim();
        models[purpose.id] = model; // "" clears — the DO treats it as unset
      }
      const response = await fetch("/api/model-config/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `save failed: ${response.status}`);
      }
      setDraft(null);
      setFeedback("Saved — new runs pick this up immediately.");
      reload();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <Card>
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">Reading model routing…</div>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card>
        <LoadErrorState message={state.message} onRetry={reload} />
      </Card>
    );
  }
  return (
    <Card>
      <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
        Purpose routing — which model does which job
      </div>
      <div className="divide-y divide-[#e0ded5]/60">
        {EDITABLE_PURPOSES.map((purpose) => (
          <div key={purpose.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[#222320]">{purpose.label}</div>
              <div className="text-[11px] text-[#6a6f63]">{purpose.hint}</div>
            </div>
            <input
              type="text"
              value={value(purpose.id)}
              onChange={(event) => {
                const next: Record<string, string> = {};
                for (const p of EDITABLE_PURPOSES) next[p.id] = value(p.id);
                next[purpose.id] = event.target.value;
                setDraft(next);
              }}
              placeholder="@cf/… (deployment default)"
              aria-label={`${purpose.label} model`}
              className="w-56 font-mono text-[11px] bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2 py-1.5 focus:outline-none focus:border-[#1c1cc8] focus:ring-1 focus:ring-[#1c1cc8]/40 placeholder-[#6a6f63]/60"
            />
          </div>
        ))}
        {FIXED_PURPOSES.map((purpose) => (
          <div key={purpose.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[#222320]">{purpose.label}</div>
              <div className="text-[11px] text-[#6a6f63]">{purpose.note}</div>
            </div>
            <span className="font-mono text-[10px] text-[#6a6f63]/70 uppercase tracking-[0.08em]">
              fixed
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-[#e0ded5] px-4 py-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || draft === null}
          className="bg-[#0000a8] hover:bg-[#1c1cc8] text-white font-semibold py-1.5 px-3 rounded-none text-xs transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save routing"}
        </button>
        {feedback ? <span className="text-xs text-[#6a6f63]">{feedback}</span> : null}
        <span className="ml-auto font-mono text-[10px] text-[#6a6f63]/70">
          {state.kind === "data" && state.data.policy.updatedAt > 0
            ? `v${state.data.policy.version} · ${new Date(state.data.policy.updatedAt).toLocaleString()}`
            : "no overrides"}
        </span>
      </div>
    </Card>
  );
}

/** Model connections — named credentials runs can route through (metadata only, never keys). */
function ConnectionsCard(): JSX.Element {
  const { state, reload } = useModelConfig();
  const [service, setService] = useState<string>(CONNECTION_SERVICES[0]);
  const [displayName, setDisplayName] = useState("");
  const [credentialRef, setCredentialRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const call = async (path: string, init: RequestInit, onDone: string) => {
    setBusy(true);
    setFeedback(null);
    try {
      const response = await fetch(`/api/model-config${path}`, {
        headers: { "Content-Type": "application/json" },
        ...init,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${init.method ?? "request"} failed: ${response.status}`);
      }
      setFeedback(onDone);
      reload();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    call("/connections", {
      method: "POST",
      body: JSON.stringify({
        service,
        displayName: displayName.trim(),
        ...(credentialRef.trim() ? { credentialRef: credentialRef.trim() } : {}),
      }),
    }, "Connection registered.");

  if (state.kind === "loading") {
    return (
      <Card>
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">Reading connections…</div>
      </Card>
    );
  }
  if (state.kind === "error") {
    return (
      <Card>
        <LoadErrorState message={state.message} onRetry={reload} />
      </Card>
    );
  }
  const connections = state.data.connections;
  return (
    <Card>
      <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
        Model connections — named credentials a run can route through
      </div>
      {connections.length === 0 ? (
        <div className="px-4 py-4 text-xs text-[#6a6f63]">
          None registered — runs fall back to the deployment default. Add one to name a specific
          AI Gateway BYOK alias or Worker secret for a provider.
        </div>
      ) : (
        <ol className="divide-y divide-[#e0ded5]/60">
          {connections.map((connection) => (
            <li key={connection.id} className="px-4 py-2.5 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[#222320]">{connection.displayName}</div>
                <div className="font-mono text-[10px] text-[#6a6f63]">
                  {connection.service}
                  {connection.credentialRef ? ` · ${connection.credentialRef}` : ""}
                </div>
              </div>
              <span
                className={`text-[10px] font-semibold uppercase tracking-[0.08em] border px-1.5 py-0.5 ${
                  connection.status === "ready"
                    ? "text-[#146c2e] bg-[#146c2e]/10 border-[#146c2e]/30"
                    : connection.status === "disabled"
                      ? "text-[#6a6f63] bg-black/[0.04] border-[#e0ded5]"
                      : "text-[#8a5a00] bg-[#f4b400]/15 border-[#f4b400]/40"
                }`}
              >
                {connection.status}
              </span>
              {connection.status === "ready" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void call(`/connections/${connection.id}`, { method: "DELETE" }, "Connection disabled.")}
                  className="text-xs text-[#6a6f63] hover:text-[#fb2c36] border border-[#e0ded5] px-2 py-1 transition-colors"
                >
                  Disable
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void call(`/connections/${connection.id}`, {
                      method: "PATCH",
                      body: JSON.stringify({ status: "ready", markChecked: true }),
                    }, "Connection marked ready.")
                  }
                  className="text-xs text-[#1c1cc8] hover:text-[#0000a8] border border-[#e0ded5] px-2 py-1 transition-colors"
                >
                  Mark ready
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
      <div className="border-t border-[#e0ded5] px-4 py-3 flex flex-wrap items-center gap-2">
        <select
          value={service}
          onChange={(event) => setService(event.target.value)}
          aria-label="Service"
          className="bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2 py-1.5 text-xs focus:outline-none focus:border-[#1c1cc8]"
        >
          {CONNECTION_SERVICES.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="Display name (e.g. Team Anthropic)"
          aria-label="Connection display name"
          className="flex-1 min-w-[140px] bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2 py-1.5 text-xs focus:outline-none focus:border-[#1c1cc8] placeholder-[#6a6f63]/60"
        />
        <input
          type="text"
          value={credentialRef}
          onChange={(event) => setCredentialRef(event.target.value)}
          placeholder="Credential alias (never a key)"
          aria-label="Credential reference"
          className="flex-1 min-w-[140px] font-mono bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2 py-1.5 text-xs focus:outline-none focus:border-[#1c1cc8] placeholder-[#6a6f63]/60"
        />
        <button
          type="button"
          disabled={busy || displayName.trim() === ""}
          onClick={() => void register()}
          className="bg-[#0000a8] hover:bg-[#1c1cc8] text-white font-semibold py-1.5 px-3 rounded-none text-xs transition-colors disabled:opacity-40"
        >
          Add connection
        </button>
      </div>
      {feedback ? <div className="px-4 pb-3 text-xs text-[#6a6f63]">{feedback}</div> : null}
    </Card>
  );
}

function EnvironmentsSection({ status }: { status: SetupStatus | undefined }): JSX.Element {
  if (!status) {
    return (
      <Card>
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          Reading /api/setup/status…
        </div>
      </Card>
    );
  }
  return (
    <Card>
      <ChecklistRow
        label="Slack signing secret"
        ok={status.slack.signingSecret}
        detail="SLACK_SIGNING_SECRET — verifies Slack callbacks"
      />
      <ChecklistRow
        label="Slack bot token"
        ok={status.slack.botToken}
        detail="SLACK_BOT_TOKEN — posts approval cards"
      />
      <ChecklistRow
        label="Slack approvers"
        ok={status.slack.approvers > 0}
        detail={`SLACK_APPROVERS — ${status.slack.approvers} configured`}
      />
      <ChecklistRow
        label="Slack channel→repo map"
        ok={status.slack.channelRepos}
        detail="SLACK_CHANNEL_REPOS — repo for bare mentions"
      />
      <ChecklistRow
        label="GitHub token"
        ok={status.github.token}
        detail="GITHUB_TOKEN — opens pull requests"
      />
      <ChecklistRow
        label="GitHub webhook secret"
        ok={status.github.webhookSecret}
        detail="GITHUB_WEBHOOK_SECRET — verifies deliveries"
      />
      <ChecklistRow
        label="AI Gateway token"
        ok={status.gateway.token}
        detail="AI_GATEWAY_TOKEN — BYOK provider egress"
      />
      <ChecklistRow
        label="AI Gateway reachable"
        ok={status.gateway.reachable === "yes"}
        detail={`gateway "${status.gateway.id}" — ${status.gateway.reachable}`}
      />
      <ChecklistRow
        label="Cloudflare Access required"
        ok={status.access.required}
        detail="REQUIRE_ACCESS / ACCESS_AUD — identity on every path"
      />
      <ChecklistRow
        label="Automations enabled"
        ok={status.automations.enabled}
        detail="AUTOMATIONS_ENABLED kill switch"
      />
      <ChecklistRow
        label="TypeSafe key"
        ok={status.automations.typeSafe}
        detail="TYPESAFE_API_KEY — System One judgments"
      />
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
    effect:
      "Registers antigravity-subscription + /api/antigravity/callback (T50 pasted-redirect OAuth).",
    related:
      "ANTIGRAVITY_SUBSCRIPTION_MODEL — no secret var (tokens live in the container profile)",
  },
  {
    flag: "SHIBA_LOCAL_RUNTIME=1",
    effect: 'Admits runtime:"local" at intake and opens the /api/local daemon surface (T51).',
    related: "LOCAL_ADAPTER_TOKEN secret — unset = the surface refuses every request",
  },
];

const KILL_SWITCHES: { flag: string; effect: string }[] = [
  { flag: "AUTOMATIONS_ENABLED", effect: '"false"/"0"/"off" stops every automation firing.' },
  {
    flag: "MEMORY_ENABLED",
    effect: '"false"/"0"/"off" disables run-end distillation into Memory — never the run.',
  },
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
  const agents = directory.state.kind === "data" ? directory.state.data.agents : [];
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
            Deployment configuration and operator surfaces — read-only mirrors of what the Worker
            reports.
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
            {section === "repositories" ? (
              <SectionShell
                title="Repositories"
                description="GitHub repos you've saved — they show up as picks in the task composer and fill in automatically when you reuse one."
              >
                <RepositoriesSection />
              </SectionShell>
            ) : section === "providers" ? (
              <SectionShell
                title="Providers"
                description="Your AI agents. Connect a provider to let it run tasks for you — disconnect any time."
              >
                <Card>
                  {(Object.keys(SUBSCRIPTION_AUTH) as SubscriptionId[]).map((id) => (
                    <ProviderLaneRow key={id} id={id} agents={agents} />
                  ))}
                </Card>
                <Card>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
                    Other credentials
                  </div>
                  {secretCredentials.length === 0 ? (
                    <div className="px-4 py-5 text-center text-xs text-[#6a6f63]">
                      {directory.state.kind === "loading"
                        ? "Loading catalog…"
                        : "No secret-backed credentials in this deployment's catalog."}
                    </div>
                  ) : (
                    secretCredentials.map((entry) => (
                      <div
                        key={entry.id}
                        className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[#222320]">{entry.label}</div>
                          <div className="font-mono text-[11px] text-[#6a6f63]">
                            {entry.credential.label}
                          </div>
                          {entry.credential.configured === false && entry.credential.setupHint ? (
                            <div className="mt-0.5 font-mono text-[11px] text-[#b45309]">
                              {entry.credential.setupHint}
                            </div>
                          ) : null}
                        </div>
                        <ToneChip
                          tone={
                            entry.credential.configured === true
                              ? "ok"
                              : entry.credential.configured === false
                                ? "danger"
                                : "neutral"
                          }
                          label={
                            entry.credential.configured === true
                              ? "Configured"
                              : entry.credential.configured === false
                                ? "Not set up"
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
            ) : section === "models" ? (
              <SectionShell
                title="Models"
                description="Which agent CLI + model each delegation role runs — resolved live from ROLE_MODEL_MAP / ROLE_MODEL__* env vars. Read-only: the Worker reports env state; set vars at deploy time."
              >
                {setup.state.kind === "error" ? (
                  <LoadErrorState message={setup.state.message} onRetry={setup.reload} />
                ) : (
                  <ModelsSection status={status} agents={agents} />
                )}
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
                      {directory.state.kind === "error"
                        ? "Could not load /api/agents."
                        : "Loading principals…"}
                    </div>
                  ) : principals.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
                      No MCP-token principals registered.
                    </div>
                  ) : (
                    principals.map((principal) => (
                      <div
                        key={principal.principal}
                        className="flex items-center justify-between gap-3 border-b border-[#e0ded5] px-4 py-2.5 last:border-b-0"
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-medium text-[#222320]">
                            {principal.principal}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {principal.scopes.map((scope) => (
                              <span
                                key={scope}
                                className="rounded-none border border-[#e0ded5] bg-[#f6f4ed] px-1.5 py-px font-mono text-[10px] text-[#6a6f63]"
                              >
                                {scope}
                              </span>
                            ))}
                          </div>
                        </div>
                        <ToneChip
                          tone={principal.live ? "ok" : "neutral"}
                          label={principal.live ? "Live" : "Revoked"}
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
                    <div
                      key={flag.flag}
                      className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0"
                    >
                      <div className="font-mono text-xs font-semibold text-[#1c1cc8]">
                        {flag.flag}
                      </div>
                      <div className="mt-0.5 text-xs text-[#222320]">{flag.effect}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-[#6a6f63]">
                        {flag.related}
                      </div>
                    </div>
                  ))}
                </Card>
                <Card>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[#6a6f63]">
                    Kill switches (env.ts)
                  </div>
                  {KILL_SWITCHES.map((flag) => (
                    <div
                      key={flag.flag}
                      className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0"
                    >
                      <div className="font-mono text-xs font-semibold text-[#1c1cc8]">
                        {flag.flag}
                      </div>
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
                    <div className="font-mono text-[11px] text-[#6a6f63]">
                      {hostname || "unknown"}
                    </div>
                  </div>
                  <div className="border-b border-[#e0ded5] px-4 py-2.5">
                    <div className="text-xs font-medium text-[#222320]">Dashboard package</div>
                    <div className="font-mono text-[11px] text-[#6a6f63]">
                      @shiba/frontend@{dashboardVersion}
                    </div>
                  </div>
                  {status ? (
                    <>
                      <div className="border-b border-[#e0ded5] px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">Orchestrator model</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">
                          {status.models.orchestrator}
                        </div>
                      </div>
                      <div className="border-b border-[#e0ded5] px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">Coding model</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">
                          {status.models.coding}
                        </div>
                      </div>
                      <div className="border-b border-[#e0ded5] px-4 py-2.5">
                        <div className="text-xs font-medium text-[#222320]">Default harness</div>
                        <div className="font-mono text-[11px] text-[#6a6f63]">
                          {status.models.harness}
                        </div>
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
                      {setup.state.kind === "error"
                        ? "Model details unavailable — /api/setup/status failed."
                        : "Reading /api/setup/status…"}
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


function RepositoriesSection(): JSX.Element {
  const repos = useSavedRepos();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    const clean = draft.trim();
    if (!clean.startsWith("https://github.com/")) {
      setError("Repository URL must look like https://github.com/owner/repo.");
      return;
    }
    saveRepo(clean);
    setDraft("");
    setError(null);
  };

  return (
    <Card>
      <div className="px-4 py-3 border-b border-[#e0ded5] flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <input
            type="url"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="https://github.com/owner/repo"
            aria-label="New repository URL"
            className="flex-1 bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-[#1c1cc8] focus:ring-1 focus:ring-[#1c1cc8]/40 placeholder-[#6a6f63]/60 transition-colors"
          />
          <button
            type="button"
            onClick={add}
            className="text-[11px] bg-[#0000a8]/10 hover:bg-[#0000a8]/15 border border-[#0000a8]/15 text-[#1c1cc8] font-medium py-1.5 px-3 rounded-none transition-colors shrink-0"
          >
            Save repo
          </button>
        </div>
        {error ? <span className="text-[11px] text-[#fb2c36]">{error}</span> : null}
      </div>
      {repos.length === 0 ? (
        <div className="px-4 py-6 text-center text-xs text-[#6a6f63]">
          None saved yet — repos you run tasks against are saved automatically too.
        </div>
      ) : (
        repos.map((repo) => (
          <div key={repo} className="border-b border-[#e0ded5] px-4 py-3 last:border-b-0 flex items-center justify-between gap-3">
            <span className="font-mono text-xs text-[#222320] truncate">{repo}</span>
            <button
              type="button"
              onClick={() => removeRepo(repo)}
              aria-label={`Remove ${repo}`}
              className="shrink-0 text-[11px] bg-transparent hover:bg-[#fb2c36]/10 border border-[#e0ded5] hover:border-[#fb2c36]/50 text-[#6a6f63] hover:text-[#fb2c36] font-medium py-1 px-2.5 rounded-none transition-colors"
            >
              Remove
            </button>
          </div>
        ))
      )}
    </Card>
  );
}
