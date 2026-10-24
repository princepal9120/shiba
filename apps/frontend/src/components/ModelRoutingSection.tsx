/**
 * ModelRoutingSection — model routing cards: purpose routing (which model
 * does each internal job) in Settings and named connections in Providers.
 * Both read/write /api/model-config via useModelConfig; credentials are
 * metadata aliases, never keys.
 */
import { AGENT_ROLES } from "@shiba/shared";
import { type JSX, useState } from "react";
import { type RoleModelWire, useModelConfig } from "../live-status";
import { LoadErrorState } from "./LoadErrorState";
import { Card } from "./settings-ui";

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
  "openai-subscription",
  "google",
  "grok",
  "opencode-go",
  "luan",
  "acp",
] as const;

const ROLE_SOURCE_LABEL: Record<RoleModelWire["source"], string> = {
  dashboard: "Dashboard pin",
  "role-map": "ROLE_MODEL_MAP",
  "role-env": "ROLE_MODEL__",
  "connection-default": "Single connection",
  default: "Deployment default",
};

/** Purpose routing — which model does each internal job. Edits save to /api/model-config/policy. */
export function PurposeRoutingCard(): JSX.Element {
  const { state, reload } = useModelConfig();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const policyModels = state.kind === "data" ? (state.data.policy?.models ?? {}) : {};
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
        <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">Reading model routing…</div>
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
      <div className="border-b border-[var(--border-1)] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
        Purpose routing — which model does which job
      </div>
      <div className="divide-y divide-[var(--border-1)]/60">
        {EDITABLE_PURPOSES.map((purpose) => (
          <div key={purpose.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[var(--fg)]">{purpose.label}</div>
              <div className="text-[11px] text-[var(--muted-foreground-2)]">{purpose.hint}</div>
            </div>
            <input
              type="text"
              value={value(purpose.id)}
              // Locked while a save is in flight — the success path clears the
              // draft wholesale, so mid-flight keystrokes would be silently lost.
              disabled={saving}
              onChange={(event) => {
                const next: Record<string, string> = {};
                for (const p of EDITABLE_PURPOSES) next[p.id] = value(p.id);
                next[purpose.id] = event.target.value;
                setDraft(next);
              }}
              placeholder="@cf/… (deployment default)"
              aria-label={`${purpose.label} model`}
              className="w-56 font-mono text-[11px] bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2 py-1.5 focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]/40 placeholder-[var(--muted-foreground-3)]/60"
            />
          </div>
        ))}
        {FIXED_PURPOSES.map((purpose) => (
          <div key={purpose.id} className="px-4 py-2.5 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium text-[var(--fg)]">{purpose.label}</div>
              <div className="text-[11px] text-[var(--muted-foreground-2)]">{purpose.note}</div>
            </div>
            <span className="font-mono text-[10px] text-[var(--muted-foreground-2)] uppercase tracking-[0.08em]">
              fixed
            </span>
          </div>
        ))}
      </div>
      <div className="border-t border-[var(--border-1)] px-4 py-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || draft === null}
          className="bg-[var(--primary)] text-[var(--primary-text)] hover:brightness-110 font-semibold py-1.5 px-3 min-h-6 touch:min-h-11 rounded-[var(--radius-button)] text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save routing"}
        </button>
        {feedback ? <span className="text-xs text-[var(--muted-foreground-2)]">{feedback}</span> : null}
        <span className="ml-auto font-mono text-[10px] text-[var(--muted-foreground-2)]">
          {state.kind === "data" && state.data.policy.updatedAt > 0
            ? `v${state.data.policy.version} · ${new Date(state.data.policy.updatedAt).toLocaleString()}`
            : "no overrides"}
        </span>
      </div>
    </Card>
  );
}

/** Per-role harness/model pins stored in the ModelConfig DO (wins over wrangler vars). */
export function RolePinsCard(): JSX.Element {
  const { state, reload } = useModelConfig();
  const [draft, setDraft] = useState<Record<string, { harness: string; model: string }> | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const policy = state.kind === "data" ? state.data.policy : null;
  const effective = state.kind === "data" ? (state.data.effectiveRoles ?? []) : [];
  const pinValue = (role: string) => {
    if (draft && role in draft) return draft[role]!;
    const pin = policy?.rolePins?.[role];
    return { harness: pin?.harness ?? "", model: pin?.model ?? "" };
  };

  const save = async () => {
    if (!policy || draft === null) return;
    setSaving(true);
    setFeedback(null);
    try {
      const rolePins: Record<string, { harness: string; model?: string }> = {};
      for (const role of AGENT_ROLES) {
        const { harness, model } = pinValue(role);
        const h = harness.trim();
        if (h === "") continue;
        rolePins[role] = model.trim() !== "" ? { harness: h, model: model.trim() } : { harness: h };
      }
      const response = await fetch("/api/model-config/policy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ models: policy.models, rolePins }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `save failed: ${response.status}`);
      }
      setDraft(null);
      setFeedback("Role pins saved — new delegations pick them up immediately.");
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
        <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">Reading role pins…</div>
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
      <div className="border-b border-[var(--border-1)] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
        Per-role model pins — dashboard overrides wrangler vars
      </div>
      <div className="divide-y divide-[var(--border-1)]/60">
        {AGENT_ROLES.map((role) => {
          const resolved = effective.find((row) => row.role === role);
          const { harness, model } = pinValue(role);
          return (
            <div key={role} className="px-4 py-2.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--fg)]">{role}</div>
                {resolved ? (
                  <div className="text-[10px] text-[var(--muted-foreground-2)]">
                    Effective: {resolved.harness}/{resolved.model}
                    {resolved.error ? (
                      <span className="text-[var(--destructive)]"> — {resolved.error}</span>
                    ) : (
                      <span> ({ROLE_SOURCE_LABEL[resolved.source]})</span>
                    )}
                  </div>
                ) : null}
              </div>
              <input
                type="text"
                value={harness}
                disabled={saving}
                onChange={(event) => {
                  const next: Record<string, { harness: string; model: string }> = {};
                  for (const r of AGENT_ROLES) next[r] = pinValue(r);
                  next[role] = { harness: event.target.value, model: next[role]?.model ?? "" };
                  setDraft(next);
                }}
                placeholder="harness"
                aria-label={`${role} harness pin`}
                className="w-36 font-mono text-[11px] bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1.5"
              />
              <input
                type="text"
                value={model}
                disabled={saving}
                onChange={(event) => {
                  const next: Record<string, { harness: string; model: string }> = {};
                  for (const r of AGENT_ROLES) next[r] = pinValue(r);
                  next[role] = { harness: next[role]?.harness ?? "", model: event.target.value };
                  setDraft(next);
                }}
                placeholder="provider/model (optional)"
                aria-label={`${role} model pin`}
                className="w-52 font-mono text-[11px] bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] px-2 py-1.5"
              />
            </div>
          );
        })}
      </div>
      <div className="border-t border-[var(--border-1)] px-4 py-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving || draft === null}
          className="bg-[var(--primary)] text-[var(--primary-text)] hover:brightness-110 font-semibold py-1.5 px-3 min-h-6 touch:min-h-11 rounded-[var(--radius-button)] text-xs disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save role pins"}
        </button>
        {feedback ? <span className="text-xs text-[var(--muted-foreground-2)]">{feedback}</span> : null}
      </div>
    </Card>
  );
}

/** Model connections — named credentials runs can route through (metadata only, never keys). */
export function ConnectionsCard(): JSX.Element {
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
        <div className="px-4 py-6 text-center text-xs text-[var(--muted-foreground-2)]">Reading connections…</div>
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
  const order = state.data.connectionOrder?.length
    ? state.data.connectionOrder
    : connections.map((c) => c.id);

  const move = async (id: string, direction: -1 | 1) => {
    const index = order.indexOf(id);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    const swap = next[target]!;
    next[target] = id;
    next[index] = swap;
    setBusy(true);
    try {
      const response = await fetch("/api/model-config/connections/order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `reorder failed: ${response.status}`);
      }
      reload();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const testConnection = (id: string) =>
    call(`/connections/${id}/test`, { method: "POST" }, "Connection tested.");

  return (
    <Card data-testid="model-connections-card">
      <div className="border-b border-[var(--border-1)] px-4 py-2.5 text-[10px] font-mono font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
        Model connections — fallback order (first listed wins when implicit)
      </div>
      {connections.length === 0 ? (
        <div className="px-4 py-4 text-xs text-[var(--muted-foreground-2)]">
          None registered — runs fall back to the deployment default. Add one to name a specific
          AI Gateway BYOK alias or Worker secret for a provider.
        </div>
      ) : (
        <ol className="divide-y divide-[var(--border-1)]/60">
          {connections.map((connection, index) => (
            <li key={connection.id} className="px-4 py-2.5 flex items-center gap-3" data-connection-id={connection.id}>
              <div className="flex flex-col gap-0.5 shrink-0">
                <button
                  type="button"
                  disabled={busy || index === 0}
                  aria-label={`Move ${connection.displayName} up`}
                  onClick={() => void move(connection.id, -1)}
                  className="text-[10px] border border-[var(--border-1)] px-1 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  type="button"
                  disabled={busy || index === connections.length - 1}
                  aria-label={`Move ${connection.displayName} down`}
                  onClick={() => void move(connection.id, 1)}
                  className="text-[10px] border border-[var(--border-1)] px-1 disabled:opacity-30"
                >
                  ↓
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[var(--fg)]">{connection.displayName}</div>
                <div className="font-mono text-[10px] text-[var(--muted-foreground-2)]">
                  {connection.service}
                  {connection.credentialRef ? ` · ${connection.credentialRef}` : ""}
                  {connection.lastCheckedAt
                    ? ` · checked ${new Date(connection.lastCheckedAt).toLocaleString()}`
                    : ""}
                </div>
              </div>
              <span
                className={`text-[10px] font-semibold uppercase tracking-[0.08em] border px-1.5 py-0.5 ${
                  connection.status === "ready"
                    ? "text-[var(--success)] bg-[color-mix(in_oklch,var(--success)_12%,transparent)] border-[color-mix(in_oklch,var(--success)_35%,transparent)]"
                    : connection.status === "disabled"
                      ? "text-[var(--muted-foreground-2)] bg-[var(--section)] border-[var(--border-1)]"
                      : "text-[var(--warning-fg)] bg-[var(--warning-subtle)] border-[var(--warning)]"
                }`}
              >
                {connection.status}
              </span>
              <button
                type="button"
                disabled={busy}
                aria-label={`Test connection ${connection.displayName}`}
                data-testid="test-connection"
                onClick={() => void testConnection(connection.id)}
                className="text-xs text-[var(--primary)] border border-[var(--border-1)] px-2 py-1 transition-colors"
              >
                Test
              </button>
              {connection.status === "ready" ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void call(`/connections/${connection.id}`, { method: "DELETE" }, "Connection disabled.")}
                  className="text-xs text-[var(--muted-foreground-2)] hover:text-[var(--destructive)] border border-[var(--border-1)] px-2 py-1 transition-colors"
                >
                  Disable
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      <div className="border-t border-[var(--border-1)] px-4 py-3 flex flex-wrap items-center gap-2">
        <select
          value={service}
          onChange={(event) => setService(event.target.value)}
          aria-label="Service"
          className="bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2 py-1.5 text-xs focus:border-[var(--primary)]"
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
          className="flex-1 min-w-[140px] bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2 py-1.5 text-xs focus:border-[var(--primary)] placeholder-[var(--muted-foreground-3)]/60"
        />
        <input
          type="text"
          value={credentialRef}
          onChange={(event) => setCredentialRef(event.target.value)}
          placeholder="Credential alias (never a key)"
          aria-label="Credential reference"
          className="flex-1 min-w-[140px] font-mono bg-[var(--panel)] border border-[var(--border-1)] rounded-[var(--radius-button)] text-[var(--fg)] px-2 py-1.5 text-xs focus:border-[var(--primary)] placeholder-[var(--muted-foreground-3)]/60"
        />
        <button
          type="button"
          disabled={busy || displayName.trim() === ""}
          onClick={() => void register()}
          className="bg-[var(--primary)] text-[var(--primary-text)] hover:brightness-110 font-semibold py-1.5 px-3 min-h-6 touch:min-h-11 rounded-[var(--radius-button)] text-xs disabled:opacity-40"
        >
          Add connection
        </button>
      </div>
      {feedback ? <div className="px-4 pb-3 text-xs text-[var(--muted-foreground-2)]">{feedback}</div> : null}
    </Card>
  );
}
