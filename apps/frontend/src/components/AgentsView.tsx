/**
 * Agents & MCP View — The Bezalel-style Agent Capability Plane on Cloudflare:
 * 1. Unified MCP Gateway (/mcp) configuration for Claude Desktop, Cursor & custom agents.
 * 2. Active Cloudflare capability modules (Vectorize Memory, Mailbox, Containers, D1 Audit).
 * 3. Authorized Agent Principals & Scopes from KV (AGENT_TOKENS).
 * 4. Pinned Sandbox CLIs catalog (OpenCode, Claude Code, Codex, Devin / swe-2).
 */
import { useEffect, useState, type JSX } from "react";
import type { AgentPrincipal } from "../types";
import { formatTimeAgo } from "../ui-helpers";

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

export function AgentsView(): JSX.Element {
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [mcpTab, setMcpTab] = useState<"claude" | "cursor" | "cli">("claude");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) throw new Error(`Agents request failed: ${response.status}`);
        const body = (await response.json()) as { agents?: AgentCli[]; principals?: AgentPrincipal[] };
        if (!cancelled) {
          setAgents(Array.isArray(body.agents) ? body.agents : []);
          setPrincipals(Array.isArray(body.principals) ? body.principals : []);
        }
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

  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedSnippet(label);
    setTimeout(() => setCopiedSnippet(null), 2000);
  };

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";
  const mcpEndpoint = `${origin}/mcp`;

  const claudeConfig = JSON.stringify(
    {
      mcpServers: {
        shiba: {
          url: mcpEndpoint,
          headers: {
            Authorization: "Bearer <YOUR_AGENT_TOKEN>",
          },
        },
      },
    },
    null,
    2
  );

  const cursorConfig = [
    "// In Cursor Settings -> MCP Servers:",
    "Name: shiba",
    "Type: sse",
    `URL: ${mcpEndpoint}`,
    "Header: Authorization: Bearer <YOUR_AGENT_TOKEN>",
  ].join("\n");

  const mintCommand = "node scripts/mint-token.mjs --principal=my-agent --scope=run,email,memory";

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-none bg-[#0000a8]/10 border border-[#0000a8]/20 text-[10px] font-mono text-[#1c1cc8] uppercase tracking-wider mb-2 font-bold">
            Capability Plane · Model Context Protocol
          </div>
          <h2 className="text-xl font-bold text-[#222320]">Agents &amp; MCP Gateway</h2>
          <p className="mt-1 text-xs text-[#6a6f63] leading-relaxed max-w-2xl font-mono">
            Connect any AI agent to your account&apos;s unified MCP gateway. Shiba gives external agents (Claude Desktop, Cursor, OpenCode, Devin) memory, email, sandboxes, and audit logging on your own Cloudflare infrastructure.
          </p>
        </div>

        {error ? (
          <div className="rounded-none border border-[#fb2c36]/30 bg-[#fb2c36]/10 px-4 py-3 text-sm text-[#fb2c36] font-mono text-xs">
            {error}
          </div>
        ) : null}

        <div className="border border-[#e0ded5] bg-[#fffef8] p-5 rounded-none shadow-[2px_2px_0_var(--paper-shadow)] space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#e0ded5] pb-3">
            <div>
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63] font-bold">Unified Gateway Endpoint</span>
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-xs font-mono font-bold text-[#0000a8] bg-[#f6f4ed] border border-[#e0ded5] px-2 py-0.5">
                  {mcpEndpoint}
                </code>
                <button
                  type="button"
                  onClick={() => copyToClipboard(mcpEndpoint, "endpoint")}
                  className="text-[11px] font-mono text-[#6a6f63] hover:text-[#222320] border border-[#e0ded5] bg-[#fffef8] px-2 py-0.5 transition-colors"
                >
                  {copiedSnippet === "endpoint" ? "Copied ✓" : "Copy URL"}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 text-[11px] font-mono font-medium text-[#15803d] bg-[#15803d]/10 border border-[#15803d]/30 px-2 py-0.5">
                <span className="size-1.5 rounded-full bg-[#15803d] animate-pulse" />
                MCP 1.30.0 Active
              </span>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-1 font-mono text-[11px]">
                <button
                  type="button"
                  onClick={() => setMcpTab("claude")}
                  className={`px-2.5 py-1 border transition-colors ${
                    mcpTab === "claude"
                      ? "border-[#0000a8] bg-[#0000a8] text-white font-bold"
                      : "border-[#e0ded5] bg-[#f6f4ed] text-[#6a6f63] hover:text-[#222320]"
                  }`}
                >
                  Claude Desktop
                </button>
                <button
                  type="button"
                  onClick={() => setMcpTab("cursor")}
                  className={`px-2.5 py-1 border transition-colors ${
                    mcpTab === "cursor"
                      ? "border-[#0000a8] bg-[#0000a8] text-white font-bold"
                      : "border-[#e0ded5] bg-[#f6f4ed] text-[#6a6f63] hover:text-[#222320]"
                  }`}
                >
                  Cursor
                </button>
                <button
                  type="button"
                  onClick={() => setMcpTab("cli")}
                  className={`px-2.5 py-1 border transition-colors ${
                    mcpTab === "cli"
                      ? "border-[#0000a8] bg-[#0000a8] text-white font-bold"
                      : "border-[#e0ded5] bg-[#f6f4ed] text-[#6a6f63] hover:text-[#222320]"
                  }`}
                >
                  Mint Token CLI
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  const text = mcpTab === "claude" ? claudeConfig : mcpTab === "cursor" ? cursorConfig : mintCommand;
                  copyToClipboard(text, "snippet");
                }}
                className="text-[11px] font-mono text-[#0000a8] hover:underline"
              >
                {copiedSnippet === "snippet" ? "Copied ✓" : "Copy Configuration"}
              </button>
            </div>

            <pre className="p-3 bg-[#0b0e10] text-[#eef4f2] text-xs font-mono overflow-x-auto border border-white/10 rounded-none leading-relaxed">
              {mcpTab === "claude" ? claudeConfig : mcpTab === "cursor" ? cursorConfig : mintCommand}
            </pre>
          </div>
        </div>

        <div>
          <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63] mb-3">
            Active Capability Modules on your Cloudflare Account
          </h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 font-mono text-xs">
            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Memory</span>
                <span className="text-[10px] text-[#15803d] font-semibold">Vectorize</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                768-dim semantic fact banking &amp; recall. Scopes: <code>memory</code>.
              </p>
              <div className="text-[10px] text-[#0000a8]/80 font-bold pt-1">
                bank_fact, recall_facts
              </div>
            </div>

            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Mailbox</span>
                <span className="text-[10px] text-[#15803d] font-semibold">Email + R2</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                Transactional inbound &amp; approval-gated sends. Scopes: <code>email</code>.
              </p>
              <div className="text-[10px] text-[#0000a8]/80 font-bold pt-1">
                list_emails, send_draft
              </div>
            </div>

            <div className="border border-[#e0ded5] bg-[#fffef8] p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-[#222320]">Sandbox</span>
                <span className="text-[10px] text-[#15803d] font-semibold">Containers</span>
              </div>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed">
                Ephemeral Docker micro-containers for code. Scopes: <code>run</code>.
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
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63]">
              Authorized Agent Tokens (KV: AGENT_TOKENS)
            </h3>
            <span className="text-[11px] font-mono text-[#6a6f63]">
              {principals.length} registered principal{principals.length === 1 ? "" : "s"}
            </span>
          </div>

          {principals.length === 0 ? (
            <div className="border border-dashed border-[#e0ded5] bg-[#fffef8] p-6 text-center rounded-none font-mono">
              <p className="text-xs font-bold text-[#222320] mb-1">No agent bearer tokens registered yet</p>
              <p className="text-[11px] text-[#6a6f63] max-w-md mx-auto mb-3">
                Mint a token to allow Claude Desktop, Cursor, or your custom background worker to access Shiba&apos;s capability plane.
              </p>
              <code className="text-[10px] bg-[#f6f4ed] border border-[#e0ded5] px-2.5 py-1 text-[#0000a8]">
                node scripts/mint-token.mjs --principal=agent-1 --scope=run,email,memory
              </code>
            </div>
          ) : (
            <div className="border border-[#e0ded5] bg-[#fffef8] rounded-none overflow-x-auto font-mono text-xs">
              <table className="w-full text-left">
                <thead className="bg-[#f6f4ed] border-b border-[#e0ded5] text-[10px] uppercase text-[#6a6f63]">
                  <tr>
                    <th className="p-2.5 font-bold">Principal Name</th>
                    <th className="p-2.5 font-bold">Granted Scopes</th>
                    <th className="p-2.5 font-bold">Registered</th>
                    <th className="p-2.5 font-bold text-right">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#e0ded5]">
                  {principals.map((p) => (
                    <tr key={p.principal} className="hover:bg-[#f6f4ed]/50 transition-colors">
                      <td className="p-2.5 font-bold text-[#222320] flex items-center gap-2">
                        <span className="size-1.5 rounded-full bg-[#0000a8]" />
                        <span>{p.principal}</span>
                      </td>
                      <td className="p-2.5">
                        <div className="flex flex-wrap gap-1">
                          {p.scopes.map((s) => (
                            <span key={s} className="px-1.5 py-0.5 bg-[#0000a8]/10 text-[#0000a8] text-[10px] border border-[#0000a8]/20 font-semibold">
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="p-2.5 text-[#6a6f63] text-[11px]">
                        {formatTimeAgo(p.created)}
                      </td>
                      <td className="p-2.5 text-right">
                        {p.live ? (
                          <span className="text-[#15803d] font-bold text-[10px] bg-[#15803d]/10 px-2 py-0.5 border border-[#15803d]/30">Active</span>
                        ) : (
                          <span className="text-[#fb2c36] font-bold text-[10px] bg-[#fb2c36]/10 px-2 py-0.5 border border-[#fb2c36]/30">Revoked</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63]">
              Sandbox Coding CLIs (Pre-installed in Docker Container)
            </h3>
            <p className="mt-0.5 text-xs text-[#6a6f63] font-mono">
              These harnesses execute inside the ephemeral Sandbox container with dummy keys. Real credentials are authenticated at AI Gateway egress.
            </p>
          </div>

          {loading ? (
            <div className="text-xs font-mono text-[#6a6f63]">Loading agent harness catalog…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {agents.map((agent) => (
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
                      <div className="mt-1 font-mono text-[11px] text-[#6a6f63]">{agent.binary}</div>
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
                      <dd className="font-mono text-[#6a6f63] truncate">{agent.credential.label}</dd>
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
