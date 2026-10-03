/**
 * Providers — connect the AI coding agents that run your tasks (Claude,
 * Codex, Antigravity, Cursor, Devin + the pre-installed sandbox CLI
 * catalog) and the capability modules they reach through the gateway.
 * The MCP gateway itself lives on Agents & MCP.
 */
import { type JSX, useEffect, useState } from "react";
import {
  type AgentCliCredential,
  SUBSCRIPTION_AUTH,
  SubscriptionConnect,
  type SubscriptionId,
  type SubscriptionStatus,
  subscriptionChip,
} from "./SubscriptionConnect";

interface AgentCli {
  id: string;
  label: string;
  binary: string;
  version: string;
  defaultModel: string;
  credential: AgentCliCredential;
  docsUrl: string;
}

function statusChip(configured: boolean | null): JSX.Element {
  if (configured === true) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-none border border-[#0000a8]/30 bg-[#0000a8]/10 px-2 py-0.5 text-[11px] font-medium text-[#1c1cc8]">
        <span className="size-1.5 rounded-full bg-[#0000a8]" />
        Ready
      </span>
    );
  }
  if (configured === false) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-none border border-[#f99c00]/30 bg-[#f99c00]/10 px-2 py-0.5 text-[11px] font-medium text-[#b45309]">
        <span className="size-1.5 rounded-full bg-[#f99c00]" />
        Needs secret
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-none border border-[#d3d2c8] bg-[#e0ded5]/60 px-2 py-0.5 text-[11px] font-medium text-[#6a6f63]">
      <span className="size-1.5 rounded-full bg-[#6a6f63]" />
      AI Gateway
    </span>
  );
}

export function ProvidersView(): JSX.Element {
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [subStatus, setSubStatus] = useState<Record<string, SubscriptionStatus>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) throw new Error(`Agents request failed: ${response.status}`);
        const body = (await response.json()) as { agents?: AgentCli[] };
        if (!cancelled) setAgents(Array.isArray(body.agents) ? body.agents : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const subscriptionIds = Object.keys(SUBSCRIPTION_AUTH) as SubscriptionId[];
  const catalogById = new Map(agents.map((agent) => [agent.id, agent]));
  // Subscription harnesses render as connectors above, not in the CLI grid.
  const cliAgents = agents.filter(
    (agent) => !(subscriptionIds as readonly string[]).includes(agent.id),
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-none bg-[#0000a8]/10 border border-[#0000a8]/20 text-[10px] font-mono text-[#1c1cc8] uppercase tracking-wider mb-2 font-bold">
            AI Agent Providers
          </div>
          <h2 className="text-xl font-bold text-[#222320]">Connect your agents</h2>
          <p className="mt-1 text-xs text-[#6a6f63] leading-relaxed max-w-2xl font-mono">
            The AI coding agents that run tasks for you. Connect a provider once — tasks you
            approve can then run in your sandbox with that agent.
          </p>
        </div>

        {error ? (
          <div className="rounded-none border border-[#fb2c36]/30 bg-[#fb2c36]/10 px-4 py-3 text-sm text-[#fb2c36] font-mono text-xs">
            {error}
          </div>
        ) : null}

        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63]">
              Connectors
            </h3>
            <p className="mt-0.5 text-xs text-[#6a6f63] font-mono">
              Subscription providers behind the gateway. Connect once; the pinned sandbox CLI
              inherits the credential.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {subscriptionIds.map((id) => {
              const spec = SUBSCRIPTION_AUTH[id];
              const row = catalogById.get(id);
              const credential = row?.credential ?? spec.credential;
              return (
                <div
                  key={id}
                  className="rounded-none border border-[#e0ded5] bg-[#fffef8] p-4 hover:border-[#d3d2c8] transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[#222320]">{spec.label}</span>
                        {row ? (
                          <span className="rounded-none border border-[#d3d2c8]/60 bg-[#f6f4ed] px-1.5 py-0.5 font-mono text-[10px] text-[#6a6f63]">
                            v{row.version}
                          </span>
                        ) : null}
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[#6a6f63]">{spec.blurb}</div>
                    </div>
                    {subscriptionChip(subStatus[id])}
                  </div>

                  <dl className="mt-3 space-y-1.5 text-[12px]">
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[#6a6f63]">Binary</dt>
                      <dd className="font-mono text-[#6a6f63] truncate">{spec.binary}</dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[#6a6f63]">Credential</dt>
                      <dd className="font-mono text-[#6a6f63] truncate">{credential.label}</dd>
                    </div>
                  </dl>

                  <SubscriptionConnect
                    spec={spec}
                    credential={credential}
                    onStatus={(status) =>
                      setSubStatus((prev) =>
                        prev[id] === status ? prev : { ...prev, [id]: status },
                      )
                    }
                  />

                  <div className="mt-3 flex items-center justify-end">
                    <a
                      href={row?.docsUrl ?? spec.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[#0000a8]/80 hover:text-[#1c1cc8] transition-colors"
                    >
                      Docs →
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        </div>


        <div>
          <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63] mb-3">
            Skills
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 font-mono text-xs">
            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Memory</span>
                <span className="text-[10px] text-[#15803d] font-semibold">Vectorize</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                Semantic fact banking &amp; recall. Scopes: <code>memory:read</code>,{" "}
                <code>memory:write</code>.
              </p>
              <div className="text-[10px] text-[#0000a8]/80 font-bold pt-1">
                memory_bank, memory_recall
              </div>
            </div>

            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Mailbox</span>
                <span className="text-[10px] text-[#15803d] font-semibold">Email + R2</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                Inbound mail &amp; approval-gated sends. Scopes: <code>email:read</code>,{" "}
                <code>email:draft</code>, <code>email:send</code>.
              </p>
              <div className="text-[10px] text-[#0000a8]/80 font-bold pt-1">
                list_emails, create_draft, send_email
              </div>
            </div>

            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Sandbox</span>
                <span className="text-[10px] text-[#15803d] font-semibold">Containers</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                Ephemeral containers for code. Scopes: <code>sandbox:exec</code>,{" "}
                <code>runs:read</code>.
              </p>
              <div className="text-[10px] text-[#0000a8]/80 font-bold pt-1">
                queue_run (Approval Gate)
              </div>
            </div>

            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Audit Trail</span>
                <span className="text-[10px] text-[#15803d] font-semibold">D1 Database</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                Every MCP call logged with SHA-256 argument hash fingerprints.
              </p>
              <div className="text-[10px] text-[#0000a8]/80 font-bold pt-1">
                Zero plaintext leakage
              </div>
            </div>
          </div>
        </div>


        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63]">
              Sandbox Coding CLIs (Pre-installed in Docker Container)
            </h3>
            <p className="mt-0.5 text-xs text-[#6a6f63] font-mono">
              These harnesses execute inside the ephemeral Sandbox container with dummy keys. Real
              credentials are authenticated at AI Gateway egress. Subscription-auth variants live
              under Connectors above.
            </p>
          </div>

          {loading ? (
            <div className="text-xs font-mono text-[#6a6f63]">Loading agent harness catalog…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {cliAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="rounded-none border border-[#e0ded5] bg-[#fffef8] p-4 hover:border-[#d3d2c8] transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-[#222320]">{agent.label}</span>
                        <span className="rounded-none border border-[#d3d2c8]/60 bg-[#f6f4ed] px-1.5 py-0.5 font-mono text-[10px] text-[#6a6f63]">
                          v{agent.version}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-[#6a6f63]">
                        {agent.binary}
                      </div>
                    </div>
                    {statusChip(agent.credential.configured)}
                  </div>

                  <dl className="mt-3 space-y-1.5 text-[12px]">
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[#6a6f63]">Model</dt>
                      <dd className="font-mono text-[#6a6f63] truncate">{agent.defaultModel}</dd>
                    </div>
                    <div className="flex items-baseline gap-2">
                      <dt className="w-20 shrink-0 text-[#6a6f63]">Credential</dt>
                      <dd className="font-mono text-[#6a6f63] truncate">
                        {agent.credential.label}
                      </dd>
                    </div>
                  </dl>

                  {agent.credential.configured === false && agent.credential.setupHint ? (
                    <div className="mt-3 rounded-none border border-[#f99c00]/20 bg-[#f99c00]/5 px-2.5 py-1.5 font-mono text-[11px] text-[#b45309]/90">
                      {agent.credential.setupHint}
                    </div>
                  ) : null}

                  <div className="mt-3 flex items-center justify-end">
                    <a
                      href={agent.docsUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-[11px] text-[#0000a8]/80 hover:text-[#1c1cc8] transition-colors"
                    >
                      Docs →
                    </a>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
