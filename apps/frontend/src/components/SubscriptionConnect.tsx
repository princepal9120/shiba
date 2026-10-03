/**
 * SubscriptionConnect — the shared connect/disconnect control for the
 * subscription-auth lanes (T48–T50): begin/verify/clear on
 * /api/auth/<provider>, plus the antigravity pasted-redirect callback.
 * Mounted by the Agents & MCP connector cards and by Settings → Providers.
 * The SHIBA_* flag gates the route too, so a 404 means the deployment has
 * it off — rendered as an unavailable hint, never a broken card.
 */

import type { AuthSnapshot } from "@shiba/shared";
import { type JSX, useEffect, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";

export interface AgentCliCredential {
  kind: "ai-gateway-byok" | "worker-secret" | "oauth-signin";
  label: string;
  configured: boolean | null;
  setupHint: string | null;
}

export type SubscriptionId =
  | "claude-subscription"
  | "codex-subscription"
  | "antigravity-subscription"
  | "cursor-subscription"
  | "devin-subscription";

export const SUBSCRIPTION_AUTH: Record<
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
      setupHint:
        "codex login, then npx wrangler secret put CODEX_SUBSCRIPTION_AUTH_JSON < ~/.codex/auth.json",
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
  "cursor-subscription": {
    apiBase: "/api/auth/cursor-subscription",
    flag: "SHIBA_CURSOR_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Cursor",
    binary: "cursor-agent",
    blurb: "Cursor subscription — Agent API key held as a Worker secret.",
    docsUrl: "https://cursor.com/docs",
    credential: {
      kind: "worker-secret",
      label: "CURSOR_SUBSCRIPTION_TOKEN",
      configured: null,
      setupHint: "npx wrangler secret put CURSOR_SUBSCRIPTION_TOKEN",
    },
  },
  "devin-subscription": {
    apiBase: "/api/auth/devin-subscription",
    flag: "SHIBA_DEVIN_SUBSCRIPTION",
    oauthRedirect: false,
    label: "Devin",
    binary: "devin",
    blurb: "Devin subscription — API key/session token held as a Worker secret.",
    docsUrl: "https://docs.devin.ai",
    credential: {
      kind: "worker-secret",
      label: "DEVIN_SUBSCRIPTION_TOKEN",
      configured: null,
      setupHint: "devin auth login, then npx wrangler secret put DEVIN_SUBSCRIPTION_TOKEN",
    },
  },
};

export type SubscriptionStatus =
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

export function chip(tone: keyof typeof CHIP_TONES, label: string): JSX.Element {
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
export function subscriptionChip(status: SubscriptionStatus | undefined): JSX.Element {
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
 * Connect/Disconnect for one subscription lane. Status comes from the flow
 * snapshot (`GET /api/auth/<provider>`), not optimistic state. Secret-token
 * providers run begin → verify in one shot; antigravity runs the pasted-
 * redirect loop: begin → open authorizationUrl → POST /api/antigravity/
 * callback → verify.
 */
export function SubscriptionConnect({
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
  const callFlow = async (
    verb: "begin" | "verify" | "clear",
  ): Promise<AuthSnapshot | undefined> => {
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
          <button type="button" onClick={disconnect} disabled={busy} className={CONNECT_SECONDARY}>
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
                  {busy ? "Connecting…" : phase === "failed" ? "Retry connect" : "Connect"}
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
