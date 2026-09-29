/**
 * Agents & MCP View — The Bezalel-style Agent Capability Plane on Cloudflare:
 * 1. Unified MCP Gateway (/mcp) configuration for Claude Desktop, Cursor & custom agents.
 * 2. Connectors — subscription providers (Claude, Codex, Antigravity) with the
 *    backend OAuth/secret-token Connect flow, live status per card.
 * 3. Custom agents — authorized MCP-token principals & scopes (KV: AGENT_TOKENS).
 * 4. Skills — capability modules agents reach through the gateway.
 * 5. Pinned Sandbox CLIs catalog (OpenCode, Claude Code, Codex, Devin / swe-2).
 */
import { useEffect, useRef, useState, type JSX } from "react";
import type { AuthSnapshot } from "@shiba/shared";
import type { AgentPrincipal } from "../types";
import { formatTimeAgo } from "../ui-helpers";
import { Tooltip } from "./Tooltip";

interface AgentCliCredential {
  kind: "ai-gateway-byok" | "worker-secret" | "oauth-signin";
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

/**
 * Subscription-auth surfaces (T48–T50): harnesses behind a
 * SHIBA_*_SUBSCRIPTION flag get a Connect flow instead of the passive
 * credential chip — begin/verify/clear on /api/auth/<provider>, plus the
 * antigravity pasted-redirect callback. The flag gates the route too, so a
 * 404 means the deployment has it off — rendered as an unavailable hint,
 * never a broken card.
 */
type SubscriptionId = "claude-subscription" | "codex-subscription" | "antigravity-subscription";

const SUBSCRIPTION_AUTH: Record<
  SubscriptionId,
  {
    apiBase: string;
    flag: string;
    oauthRedirect: boolean;
    label: string;
    binary: string;
    blurb: string;
    docsUrl: string;
    /** Rendered when the flag is off and the catalog has no row for the card. */
    credential: AgentCliCredential;
  }
> = {
  "claude-subscription": {
    apiBase: "/api/auth/claude-subscription",
    flag: "SHIBA_CLAUDE_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Claude",
    binary: "claude",
    blurb: "Claude Pro/Max subscription — setup token held as a Worker secret.",
    docsUrl: "https://docs.anthropic.com/en/docs/claude-code",
    credential: {
      kind: "worker-secret",
      label: "CLAUDE_SUBSCRIPTION_TOKEN",
      configured: null,
      setupHint: "claude setup-token, then npx wrangler secret put CLAUDE_SUBSCRIPTION_TOKEN",
    },
  },
  "codex-subscription": {
    apiBase: "/api/auth/codex-subscription",
    flag: "SHIBA_CODEX_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Codex",
    binary: "codex",
    blurb: "ChatGPT subscription — Codex auth.json held as a Worker secret.",
    docsUrl: "https://github.com/openai/codex",
    credential: {
      kind: "worker-secret",
      label: "CODEX_SUBSCRIPTION_AUTH_JSON",
      configured: null,
      setupHint: "codex login, then npx wrangler secret put CODEX_SUBSCRIPTION_AUTH_JSON < ~/.codex/auth.json",
    },
  },
  "antigravity-subscription": {
    apiBase: "/api/auth/antigravity-subscription",
    flag: "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
    oauthRedirect: true,
    label: "Antigravity",
    binary: "agy",
    blurb: "Google account sign-in — OAuth runs inside the auth sandbox.",
    docsUrl: "https://antigravity.google",
    credential: {
      kind: "oauth-signin",
      label: "Google sign-in (in-container OAuth)",
      configured: null,
      setupHint: null,
    },
  },
};

type SubscriptionStatus =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "snapshot"; snapshot: AuthSnapshot };

const CHIP_TONES = {
  ok: "border-[#15803d]/30 bg-[#15803d]/10 text-[#15803d]",
  danger: "border-[#fb2c36]/30 bg-[#fb2c36]/10 text-[#fb2c36]",
  pending: "border-[#f99c00]/30 bg-[#f99c00]/10 text-[#b45309]",
  navy: "border-[#0000a8]/30 bg-[#0000a8]/10 text-[#1c1cc8]",
  neutral: "border-[#d3d2c8] bg-[#e0ded5]/60 text-[#6a6f63]",
} as const;

const CHIP_DOTS = {
  ok: "bg-[#15803d]",
  danger: "bg-[#fb2c36]",
  pending: "bg-[#f99c00]",
  navy: "bg-[#0000a8]",
  neutral: "bg-[#6a6f63]",
} as const;

function chip(tone: keyof typeof CHIP_TONES, label: string): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-none border px-2 py-0.5 text-[11px] font-medium ${CHIP_TONES[tone]}`}
    >
      <span className={`size-1.5 rounded-full ${CHIP_DOTS[tone]}`} />
      {label}
    </span>
  );
}

/** The card chip reflects the live auth-flow phase, not credential presence. */
function subscriptionChip(status: SubscriptionStatus | undefined): JSX.Element {
  if (status?.kind === "unavailable") return chip("neutral", "Unavailable");
  const phase = status?.kind === "snapshot" ? status.snapshot.phase : undefined;
  switch (phase) {
    case "succeeded":
      return chip("ok", "Connected");
    case "failed":
      return chip("danger", "Auth failed");
    case "waiting":
      return chip("pending", "Sign-in pending");
    case "starting":
    case "verifying":
      return chip("navy", "Connecting");
    case "idle":
    case "cleared":
      return chip("neutral", "Not connected");
    default:
      return chip("neutral", "Checking…");
  }
}

const CONNECT_PRIMARY =
  "bg-[#0000a8] hover:bg-[#1c1cc8] text-white font-semibold py-1 px-3 rounded-none transition-colors disabled:opacity-40 disabled:cursor-not-allowed text-[11px] font-mono shadow-[2px_2px_0_var(--paper-shadow)] active:translate-y-px";
const CONNECT_SECONDARY =
  "text-[11px] font-mono font-medium text-[#6a6f63] hover:text-[#222320] border border-[#e0ded5] hover:border-[#d3d2c8] bg-[#fffef8] px-2.5 py-1 rounded-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Connect/Disconnect for one subscription card. Status comes from the flow
 * snapshot (`GET /api/auth/<provider>`), not optimistic state. Secret-token
 * providers run begin → verify in one shot; antigravity runs the pasted-
 * redirect loop: begin → open authorizationUrl → POST /api/antigravity/
 * callback → verify.
 */
function SubscriptionConnect({
  spec,
  credential,
  onStatus,
}: {
  spec: (typeof SUBSCRIPTION_AUTH)[SubscriptionId];
  credential: AgentCliCredential;
  onStatus: (status: SubscriptionStatus) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<AuthSnapshot | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteUrl, setPasteUrl] = useState("");
  const [callbackSent, setCallbackSent] = useState(false);
  const account = "default";

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;

  const applySnapshot = (next: AuthSnapshot | undefined) => {
    if (next === undefined) return;
    setSnapshot(next);
    onStatusRef.current({ kind: "snapshot", snapshot: next });
  };

  const markUnavailable = () => {
    setUnavailable(true);
    onStatusRef.current({ kind: "unavailable" });
  };

  /** POST a flow verb; returns the fresh snapshot, undefined when the route is dark. */
  const callFlow = async (verb: "begin" | "verify" | "clear"): Promise<AuthSnapshot | undefined> => {
    const response = await fetch(`${spec.apiBase}/${verb}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account }),
    });
    if (response.status === 404) {
      markUnavailable();
      return undefined;
    }
    const body = (await response.json().catch(() => ({}))) as {
      snapshot?: AuthSnapshot;
      error?: string;
    };
    if (!response.ok) {
      throw new Error(body.error ?? `Auth request failed: ${response.status}`);
    }
    applySnapshot(body.snapshot);
    return body.snapshot;
  };

  const refresh = async (): Promise<void> => {
    const response = await fetch(`${spec.apiBase}?account=${account}`);
    if (response.status === 404) {
      markUnavailable();
      return;
    }
    const body = (await response.json().catch(() => ({}))) as { snapshot?: AuthSnapshot };
    applySnapshot(body.snapshot);
  };

  useEffect(() => {
    let cancelled = false;
    onStatusRef.current({ kind: "loading" });
    (async () => {
      try {
        const response = await fetch(`${spec.apiBase}?account=default`);
        if (response.status === 404) {
          if (!cancelled) {
            setUnavailable(true);
            onStatusRef.current({ kind: "unavailable" });
          }
          return;
        }
        const body = (await response.json().catch(() => ({}))) as { snapshot?: AuthSnapshot };
        if (!cancelled && body.snapshot !== undefined) {
          setSnapshot(body.snapshot);
          onStatusRef.current({ kind: "snapshot", snapshot: body.snapshot });
        }
      } catch {
        // The card still renders; connect attempts surface their own error.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec.apiBase]);

  /** Run a flow step; a thrown error lands in the card and a refresh restores truth. */
  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setFlowError(null);
    setNotice(null);
    try {
      await work();
    } catch (err) {
      setFlowError(err instanceof Error ? err.message : String(err));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const connect = () =>
    void run(async () => {
      const snap = await callFlow("begin");
      if (spec.oauthRedirect) {
        setCallbackSent(false);
        // Popup blockers can refuse an async open — the waiting panel always
        // renders the same URL as a link.
        if (snap?.authorizationUrl !== undefined) {
          window.open(snap.authorizationUrl, "_blank", "noopener,noreferrer");
        }
      } else {
        await callFlow("verify");
      }
    });

  const submitPaste = () =>
    void run(async () => {
      const response = await fetch("/api/antigravity/callback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account, url: pasteUrl.trim() }),
      });
      if (response.status === 404) {
        markUnavailable();
        return;
      }
      const body = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(body.error ?? `Callback request failed: ${response.status}`);
      }
      setCallbackSent(true);
      setPasteUrl("");
      setNotice(body.message ?? "Sign-in response delivered.");
      await callFlow("verify");
    });

  const verifyAgain = () => void run(async () => void (await callFlow("verify")));

  const disconnect = () =>
    void run(async () => {
      await callFlow("clear");
      setCallbackSent(false);
      setPasteUrl("");
    });

  const phase = snapshot?.phase;
  const needsSecret = credential.kind === "worker-secret" && credential.configured === false;
  const owner =
    snapshot?.ownerSessionId !== null &&
    snapshot?.ownerSessionId !== undefined &&
    snapshot.ownerSessionId !== "default"
      ? snapshot.ownerSessionId
      : undefined;

  return (
    <div className="mt-3 space-y-2 border-t border-[#e0ded5]/60 pt-3">
      {unavailable ? (
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[11px] text-[#6a6f63]">Subscription auth is off</span>
          <Tooltip
            content={`Enable ${spec.flag}=1 on the Worker to use this flow`}
            side="top"
            align="end"
          >
            <span className="inline-flex">
              <button type="button" disabled className={CONNECT_PRIMARY}>
                Connect
              </button>
            </span>
          </Tooltip>
        </div>
      ) : phase === "waiting" ? (
        <div className="space-y-2">
          <p className="font-mono text-[11px] leading-relaxed text-[#6a6f63]">
            {snapshot?.message ??
              "Open the sign-in URL, complete sign-in, then paste the failed redirect URL."}
            {owner !== undefined ? ` Owner: ${owner}.` : ""}
          </p>
          {snapshot?.authorizationUrl !== undefined ? (
            <div>
              <a
                href={snapshot.authorizationUrl}
                target="_blank"
                rel="noreferrer"
                className={`${CONNECT_PRIMARY} inline-flex`}
              >
                Open sign-in ↗
              </a>
            </div>
          ) : null}
          {callbackSent ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={verifyAgain}
                disabled={busy}
                className={CONNECT_PRIMARY}
              >
                {busy ? "Checking…" : "Check status"}
              </button>
              <button
                type="button"
                onClick={disconnect}
                disabled={busy}
                className={CONNECT_SECONDARY}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="url"
                value={pasteUrl}
                onChange={(event) => setPasteUrl(event.target.value)}
                placeholder="http://127.0.0.1:…/?code=…&state=…"
                aria-label="Pasted OAuth redirect URL"
                className="min-w-0 flex-1 rounded-none border border-[#e0ded5] bg-[#f1efe6] px-2.5 py-1.5 font-mono text-xs text-[#222320] transition-colors placeholder-[#6a6f63]/60 focus:border-[#1c1cc8] focus:outline-none focus:ring-1 focus:ring-[#1c1cc8]/40"
              />
              <button
                type="button"
                onClick={submitPaste}
                disabled={busy || pasteUrl.trim() === ""}
                className={CONNECT_PRIMARY}
              >
                {busy ? "Sending…" : "Submit"}
              </button>
            </div>
          )}
          {callbackSent ? null : (
            <button
              type="button"
              onClick={disconnect}
              disabled={busy}
              className="font-mono text-[10px] text-[#6a6f63] hover:text-[#222320]"
            >
              Cancel sign-in
            </button>
          )}
        </div>
      ) : phase === "succeeded" ? (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-[#15803d]">
            account: {account}
            {owner !== undefined ? ` · ${owner}` : ""}
            {snapshot?.expiresAt !== undefined
              ? ` · valid until ${new Date(snapshot.expiresAt).toLocaleDateString()}`
              : ""}
          </span>
          <button
            type="button"
            onClick={disconnect}
            disabled={busy}
            className={CONNECT_SECONDARY}
          >
            {busy ? "…" : "Disconnect"}
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <span className="truncate font-mono text-[11px] text-[#6a6f63]">
            {phase === "starting" || phase === "verifying"
              ? "Connecting…"
              : phase === "failed"
                ? "Connection failed"
                : "Subscription account"}
          </span>
          <div className="flex items-center gap-2">
            {spec.oauthRedirect && phase === "failed" ? (
              <button
                type="button"
                onClick={verifyAgain}
                disabled={busy}
                className={CONNECT_SECONDARY}
              >
                Check again
              </button>
            ) : null}
            <Tooltip
              disabled={!needsSecret}
              content={credential.setupHint ?? "Provision the credential first."}
              side="top"
              align="end"
            >
              <span className="inline-flex">
                <button
                  type="button"
                  onClick={connect}
                  disabled={busy || needsSecret}
                  className={CONNECT_PRIMARY}
                >
                  {busy
                    ? "Connecting…"
                    : phase === "failed"
                      ? "Retry connect"
                      : "Connect"}
                </button>
              </span>
            </Tooltip>
          </div>
        </div>
      )}
      {flowError !== null ? (
        <div className="border border-[#fb2c36]/30 bg-[#fb2c36]/10 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[#fb2c36]">
          {flowError}
        </div>
      ) : null}
      {notice !== null && flowError === null ? (
        <div className="border border-[#0000a8]/25 bg-[#0000a8]/10 px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-[#1c1cc8]">
          {notice}
        </div>
      ) : null}
    </div>
  );
}

export function AgentsView(): JSX.Element {
  const [agents, setAgents] = useState<AgentCli[]>([]);
  const [principals, setPrincipals] = useState<AgentPrincipal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copiedSnippet, setCopiedSnippet] = useState<string | null>(null);
  const [mcpTab, setMcpTab] = useState<"claude" | "cursor" | "cli">("cli");
  const [subStatus, setSubStatus] = useState<Record<string, SubscriptionStatus>>({});

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

  const origin = typeof window !== "undefined" ? window.location.origin : "https://your-worker.workers.dev";
  const mcpEndpoint = `${origin}/mcp`;
  const workerHost = typeof window !== "undefined" && !["localhost", "127.0.0.1"].includes(window.location.hostname)
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
    2
  );

  const cursorConfig = [
    "// In Cursor Settings -> MCP Servers:",
    "Name: shiba",
    "Transport: Streamable HTTP",
    `URL: ${mcpEndpoint}`,
    "Header: Authorization: Bearer <YOUR_AGENT_TOKEN>",
  ].join("\n");

  const mintCommand = `node scripts/mint-token.mjs --agent scout --scopes email:read --host ${workerHost} --namespace-id <agentTokensNamespace> --write`;

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
            <span className="text-[11px] font-mono text-[#6a6f63]">MCP endpoint; connection not verified here</span>
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
            <p className="mt-2 text-[11px] text-[#6a6f63]">Replace <code>scout</code> with the exact principal assigned in Inbox. Minting without --write only prints a token; it cannot authenticate until its hash is stored in the deployed AGENT_TOKENS namespace. Never paste the token into a mailbox or a public log. <a href="/docs/mcp/" className="text-[#0000a8] hover:underline">Connection guide</a></p>
          </div>
        </div>

        <div>
          <div className="mb-3">
            <h3 className="text-xs font-mono font-bold uppercase tracking-wider text-[#6a6f63]">
              Connectors
            </h3>
            <p className="mt-0.5 text-xs text-[#6a6f63] font-mono">
              Subscription providers behind the gateway. Connect once; the pinned sandbox CLI inherits the credential.
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
                      setSubStatus((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }))
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
                Semantic fact banking &amp; recall. Scopes: <code>memory:read</code>, <code>memory:write</code>.
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
                Inbound mail &amp; approval-gated sends. Scopes: <code>email:read</code>, <code>email:draft</code>, <code>email:send</code>.
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
                Ephemeral containers for code. Scopes: <code>sandbox:exec</code>, <code>runs:read</code>.
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
              Custom Agents (KV: AGENT_TOKENS)
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
                {mintCommand}
              </code>
              <div className="mt-3"><a href="/?tab=inbox" className="text-[#0000a8] hover:underline">Open Inbox setup →</a></div>
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
              These harnesses execute inside the ephemeral Sandbox container with dummy keys. Real credentials are authenticated at AI Gateway egress. Subscription-auth variants live under Connectors above.
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
