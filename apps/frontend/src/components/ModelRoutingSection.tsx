/**
 * ModelRoutingSection — the Settings → Models routing cards: purpose routing
 * (which model does each internal job) and model connections (named
 * credentials runs can route through). Both read/write /api/model-config via
 * useModelConfig; credentials are metadata aliases, never keys.
 */
import { type JSX, useState } from "react";
import { useModelConfig } from "../live-status";
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
  "google",
  "devin",
  "opencode-go",
  "cursor",
] as const;

/** Purpose routing — which model does each internal job. Edits save to /api/model-config/policy. */
export function PurposeRoutingCard(): JSX.Element {
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
