/**
 * Agents & MCP — the unified MCP gateway (/mcp): endpoint configuration for
 * Claude Desktop, Cursor & custom agents, plus the authorized MCP-token
 * principals & scopes (KV: AGENT_TOKENS). Agent providers, skills, and the
 * sandbox CLI catalog live on the Providers page.
 */
import { type JSX, useEffect, useRef, useState } from "react";
import type { AgentPrincipal } from "../types";
import { formatTimeAgo } from "../ui-helpers";
export function AgentsView(): JSX.Element {
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [mcpTab, setMcpTab] = useState<"claude" | "cursor" | "cli">("cli");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await fetch("/api/agents");
        if (!response.ok) throw new Error(`Agents request failed: ${response.status}`);
        const body = (await response.json()) as { principals?: AgentPrincipal[] };
        if (!cancelled) setPrincipals(Array.isArray(body.principals) ? body.principals : []);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyTimerRef = useRef<number | null>(null);
  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedSnippet(label);
    // A rapid second click restarts the countdown instead of leaving the
    // first timer to clear the new label early.
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopiedSnippet(null);
    }, 2000);
  };

  const origin =
    typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";
  const mcpEndpoint = `${origin}/mcp`;
  const workerHost =
    typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname)
      ? window.location.host
      : "<worker-host>";

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
    2,
  );

  const cursorConfig = [
    "// In Cursor Settings -> MCP Servers:",
    "Name: shiba",
    "Transport: Streamable HTTP",
    `URL: ${mcpEndpoint}`,
    "Header: Authorization: Bearer <YOUR_AGENT_TOKEN>",
  ].join("\n");

  const mintCommand = `node scripts/mint-token.mjs --agent scout --scopes email:read --host ${workerHost} --namespace-id <agentTokensNamespace> --write`;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-8 space-y-8">
        <div>
          <div className="inline-flex items-center gap-2 px-2.5 py-0.5 rounded-none bg-[#0000a8]/10 border border-[#0000a8]/20 text-[10px] font-mono text-[#1c1cc8] uppercase tracking-wider mb-2 font-bold">
            Capability Plane · Model Context Protocol
          </div>
          <h2 className="text-xl font-bold text-[#222320]">MCP Gateway</h2>
          <p className="mt-1 text-xs text-[#6a6f63] leading-relaxed max-w-2xl font-mono">
            Connect any AI agent to your account&apos;s unified MCP gateway. Shiba gives external
            agents (Claude Desktop, Cursor, OpenCode, Devin) memory, email, sandboxes, and audit
            logging on your own Cloudflare infrastructure.
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
              <span className="text-[10px] font-mono uppercase tracking-wider text-[#6a6f63] font-bold">
                Unified Gateway Endpoint
              </span>
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
            <span className="text-[11px] font-mono text-[#6a6f63]">
              MCP endpoint; connection not verified here
            </span>
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
                  const text =
                    mcpTab === "claude"
                      ? claudeConfig
                      : mcpTab === "cursor"
                        ? cursorConfig
                        : mintCommand;
                  copyToClipboard(text, "snippet");
                }}
                className="text-[11px] font-mono text-[#0000a8] hover:underline"
              >
                {copiedSnippet === "snippet" ? "Copied ✓" : "Copy Configuration"}
              </button>
            </div>

            <pre className="p-3 bg-[#0b0e10] text-[#eef4f2] text-xs font-mono overflow-x-auto border border-white/10 rounded-none leading-relaxed">
              {mcpTab === "claude"
                ? claudeConfig
                : mcpTab === "cursor"
                  ? cursorConfig
                  : mintCommand}
            </pre>
            <p className="mt-2 text-[11px] text-[#6a6f63]">
              Replace <code>scout</code> with the exact principal assigned in Inbox. Minting without
              --write only prints a token; it cannot authenticate until its hash is stored in the
              deployed AGENT_TOKENS namespace. Never paste the token into a mailbox or a public log.{" "}
              <a href="/docs/mcp/" className="text-[#0000a8] hover:underline">
                Connection guide
              </a>
            </p>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63]">
              Custom Agents (KV: AGENT_TOKENS)
            </h3>
            <span className="text-[11px] font-mono text-[#6a6f63]">
              {principals.length} registered principal{principals.length === 1 ? "" : "s"}
            </span>
          </div>

          {principals.length === 0 ? (
            <div className="border border-dashed border-[#e0ded5] bg-[#fffef8] p-6 text-center rounded-none font-mono">
              <p className="text-xs font-bold text-[#222320] mb-1">
                No agent bearer tokens registered yet
              </p>
              <p className="text-[11px] text-[#6a6f63] max-w-md mx-auto mb-3">
                Mint a token to allow Claude Desktop, Cursor, or your custom background worker to
                access Shiba&apos;s capability plane.
              </p>
              <code className="text-[10px] bg-[#f6f4ed] border border-[#e0ded5] px-2.5 py-1 text-[#0000a8]">
                {mintCommand}
              </code>
              <div className="mt-3">
                <a href="/?tab=inbox" className="text-[#0000a8] hover:underline">
                  Open Inbox setup →
                </a>
              </div>
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
                            <span
                              key={s}
                              className="px-1.5 py-0.5 bg-[#0000a8]/10 text-[#0000a8] text-[10px] border border-[#0000a8]/20 font-semibold"
                            >
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
                          <span className="text-[#15803d] font-bold text-[10px] bg-[#15803d]/10 px-2 py-0.5 border border-[#15803d]/30">
                            Active
                          </span>
                        ) : (
                          <span className="text-[#fb2c36] font-bold text-[10px] bg-[#fb2c36]/10 px-2 py-0.5 border border-[#fb2c36]/30">
                            Revoked
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

      </div>
    </div>
  );
}
