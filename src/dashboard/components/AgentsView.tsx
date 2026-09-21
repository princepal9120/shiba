/**
 * Agents view — the agentic CLIs baked into the sandbox image, with the
 * credential each needs and whether this deployment has it configured.
 * Data comes from /api/agents (src/harness/catalog.ts); the image is the
 * install surface, so versions shown are the Dockerfile pins.
 */
import { useEffect, useState, type JSX } from "react";

interface AgentCliCredential {
  kind: "ai-gateway-byok" | "worker-secret";
  label: string;
  configured: boolean | null;
  setupHint: string | null;
}

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
      <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-300">
        <span className="size-1.5 rounded-full bg-teal-400" />
        Ready
      </span>
    );
  }
  if (configured === false) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-amber-300">
        <span className="size-1.5 rounded-full bg-amber-400" />
        Needs secret
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-500">
      <span className="size-1.5 rounded-full bg-[#8b98a9]" />
      AI Gateway
    </span>
  );
}

export function AgentsView(): JSX.Element {
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-5">
        <div className="mb-6">
          <h2 className="text-sm font-semibold text-zinc-100">Agents</h2>
          <p className="mt-1 text-[13px] text-zinc-500 leading-relaxed">
            Agent CLIs baked into the sandbox image on this account. Pick one per task in the composer;
            credentials are injected at the egress boundary and never enter the container.
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-white/[0.10] bg-white/[0.04] px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        ) : loading ? (
          <div className="text-sm text-zinc-500">Loading agent catalog…</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="rounded-lg border border-white/[0.07] bg-[#101013] p-4 hover:border-white/[0.10] transition-colors"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-zinc-100">{agent.label}</span>
                      <span className="rounded-md border border-white/[0.07] bg-white/[0.02] px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">
                        v{agent.version}
                      </span>
                    </div>
                    <div className="mt-1 font-mono text-[11px] text-zinc-600">{agent.binary}</div>
                  </div>
                  {statusChip(agent.credential.configured)}
                </div>

                <dl className="mt-3 space-y-1.5 text-[12px]">
                  <div className="flex items-baseline gap-2">
                    <dt className="w-20 shrink-0 text-zinc-600">Model</dt>
                    <dd className="font-mono text-zinc-500 truncate">{agent.defaultModel}</dd>
                  </div>
                  <div className="flex items-baseline gap-2">
                    <dt className="w-20 shrink-0 text-zinc-600">Credential</dt>
                    <dd className="font-mono text-zinc-500 truncate">{agent.credential.label}</dd>
                  </div>
                </dl>

                {agent.credential.configured === false && agent.credential.setupHint ? (
                  <div className="mt-3 rounded-md border border-white/[0.10] bg-white/[0.04] px-2.5 py-1.5 font-mono text-[11px] text-amber-200/90">
                    {agent.credential.setupHint}
                  </div>
                ) : null}

                <div className="mt-3 flex items-center justify-end">
                  <a
                    href={agent.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-zinc-300/80 hover:text-zinc-300 transition-colors"
                  >
                    Docs →
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-zinc-600">
          The image is the install surface: containers are ephemeral per run, so CLIs ship pinned in the
          Dockerfile and every run picks one at exec time. Adding a CLI means a Dockerfile entry plus a
          harness adapter — nothing here mutates a live sandbox.
        </p>
      </div>
    </div>
  );
}
