import type { AcpProviderCard, AcpProvidersSnapshot } from "@shiba/shared";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import { desktopCanSignInClaude, desktopCodexAuthorizationUrl } from "../desktop-provider";
import { LoadErrorState } from "./LoadErrorState";
import { ConnectionsCard } from "./ModelRoutingSection";
import { providerPhaseLabel } from "./provider-phase";
import { EmptyState, PageHeader, StatusNotice } from "./surface";
import { ToneChip } from "./ToneChip";

type CardAction =
  | "oauth"
  | "setup-token"
  | "api-key"
  | "verify"
  | "test"
  | "disconnect"
  | "default";

const SHIBA_OAUTH_CALLBACK_MESSAGE = "shiba-oauth-callback";

function isProviderLoopbackCallback(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return false;
    if (parsed.pathname !== "/callback" && parsed.pathname !== "/auth/callback") return false;
    return parsed.port === "51121" || parsed.port === "56121" || parsed.port === "" || parsed.pathname === "/auth/callback";
  } catch {
    return false;
  }
}

function actionLabel(
  busy: boolean,
  action: CardAction | null,
  expected: CardAction,
  idle: string,
  active: string,
): string {
  return busy && action === expected ? active : idle;
}

const PRIMARY =
  "inline-flex min-h-6 touch:min-h-11 items-center bg-[var(--primary)] text-[var(--primary-text)] font-mono text-[11px] font-semibold px-3 py-1.5 shadow-[var(--sh-card)] active:translate-y-px hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed";
const SECONDARY =
  "inline-flex min-h-6 touch:min-h-11 items-center border border-[var(--border-1)] bg-[var(--card)] px-2.5 py-1.5 font-mono text-[11px] font-medium text-[var(--fg)] hover:bg-[var(--secondary)] active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed";

function ProviderSkeleton(): JSX.Element {
  return (
    <div
      className="border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]"
      aria-hidden="true"
    >
      <div className="flex items-center justify-between border-b border-[var(--border-1)] bg-[var(--panel)] px-3 py-2.5">
        <div className="skeleton h-3 w-28" />
        <div className="skeleton h-4 w-16" />
      </div>
      <div className="space-y-2 px-3 py-3">
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-3 w-2/3" />
        <div className="skeleton mt-3 h-7 w-36" />
      </div>
      <div className="border-t border-[var(--border-1)] px-3 py-2">
        <div className="skeleton h-3 w-40" />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <span className="min-w-0 bg-[var(--card)] px-2.5 py-1.5" title={`${label} ${value}`}>
      <span className="uppercase tracking-[0.12em]">{label} </span>
      <span className="text-[var(--fg)]">{value}</span>
    </span>
  );
}

function NewTabLabel({ children }: { children: string }): JSX.Element {
  return (
    <>
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </>
  );
}

function OperatorSteps({
  id,
  steps,
}: {
  id: string;
  steps: readonly string[];
}): JSX.Element | null {
  if (steps.length === 0) return null;
  return (
    <ol
      data-testid={`provider-steps-${id}`}
      className="mt-2 list-decimal space-y-1 pl-4 font-mono text-[11px] leading-relaxed text-[var(--fg)]"
    >
      {steps.map((step) => (
        <li key={step}>{step}</li>
      ))}
    </ol>
  );
}

const PASTE_KEY_LABEL: Record<string, string> = {
  gemini: "Gemini API key",
  grok: "xAI API key",
};

function WaitingSignIn({
  card,
  busy,
  action,
  onVerify,
  onDisconnect,
}: {
  card: AcpProviderCard;
  busy: boolean;
  action: CardAction | null;
  onVerify: (id: string, body: Record<string, string>) => void;
  onDisconnect: (id: string) => void;
}): JSX.Element {
  const [callbackUrl, setCallbackUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const device = Boolean(card.connection.userCode);
  const needsCallback =
    card.connection.signInKind === "chatgpt-pkce" ||
    card.connection.signInKind === "antigravity-pkce" ||
    card.connection.signInKind === "xai-pkce";
  const cursorPoll = card.connection.signInKind === "cursor-pkce";
  const needsToken = card.connection.signInKind === "claude-setup-token";
  const steps = card.connection.operatorSteps ?? [];
  const verificationUri = card.connection.verificationUri;
  const finishRef = useRef<() => void>(() => {});
  const codexAuthorization = desktopCodexAuthorizationUrl(verificationUri);
  function finish(): void {
    if (device && callbackUrl.trim() !== "") {
      onVerify(card.id, { callbackUrl: callbackUrl.trim() });
      return;
    }
    if (device && card.connection.userCode) {
      onVerify(card.id, { userCode: card.connection.userCode });
      return;
    }
    if (needsToken) {
      onVerify(card.id, { credential: credential.trim() });
      return;
    }
    if (needsCallback) {
      onVerify(card.id, { callbackUrl: callbackUrl.trim() });
      return;
    }
    onVerify(card.id, {});
  }
  finishRef.current = finish;
  useEffect(() => {
    if (!needsCallback && !device) return;
    function onMessage(event: MessageEvent): void {
      if (!event.origin.startsWith("http://127.0.0.1:")) return;
      const data = event.data;
      if (
        typeof data !== "object" ||
        data === null ||
        (data as { type?: unknown }).type !== SHIBA_OAUTH_CALLBACK_MESSAGE ||
        typeof (data as { url?: unknown }).url !== "string"
      ) {
        return;
      }
      const url = (data as { url: string }).url;
      if (!isProviderLoopbackCallback(url)) return;
      setCallbackUrl(url);
      onVerify(card.id, { callbackUrl: url });
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [needsCallback, device, card.id, onVerify]);
  useEffect(() => {
    if (!cursorPoll || busy) return;
    const timer = window.setInterval(() => {
      finishRef.current();
    }, 3_000);
    return () => window.clearInterval(timer);
  }, [cursorPoll, busy, card.id]);
  useEffect(() => {
    if (!needsCallback || busy) return;
    const oauthState = card.connection.oauthState?.trim() ?? "";
    if (oauthState === "") return;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/dev/oauth-loopback?state=${encodeURIComponent(oauthState)}&provider=${encodeURIComponent(card.id)}`,
        );
        if (!response.ok) return;
        const data = (await response.json()) as { callbackUrl?: string | null };
        const url = data.callbackUrl?.trim() ?? "";
        if (url === "" || !isProviderLoopbackCallback(url)) return;
        setCallbackUrl(url);
        onVerify(card.id, { callbackUrl: url });
      } catch {
        // Worker may still be starting.
      }
    };
    const timer = window.setInterval(() => {
      void poll();
    }, 1_500);
    void poll();
    return () => window.clearInterval(timer);
  }, [needsCallback, busy, card.id, card.connection.oauthState, onVerify]);
  return (
    <div className="mt-3 border border-[var(--border-1)] bg-[var(--panel)] px-3 py-3">
      <OperatorSteps id={card.id} steps={steps} />
      {device ? (
        <p className="mt-3 font-mono text-lg tracking-[0.18em] text-[var(--fg)]">
          {card.connection.userCode}
        </p>
      ) : null}
      {needsCallback || device ? (
        <label className="mt-3 block">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
            {device ? "Callback URL (optional)" : "Callback URL (optional if loopback is running)"}
          </span>
          <textarea
            data-testid={`provider-callback-${card.id}`}
            className="mt-1 min-h-[72px] w-full border border-[var(--border-1)] bg-[var(--card)] p-2 font-mono text-[11px] text-[var(--fg)]"
            value={callbackUrl}
            onChange={(event) => setCallbackUrl(event.target.value)}
            placeholder="http://127.0.0.1:52841/auth/callback?state=…&code=…"
            disabled={busy}
          />
        </label>
      ) : null}
      {needsToken ? (
        <label className="mt-3 block">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
            Setup token
          </span>
          <input
            type="password"
            data-testid={`provider-setup-token-${card.id}`}
            className="mt-1 w-full border border-[var(--border-1)] bg-[var(--card)] p-2 font-mono text-[11px] text-[var(--fg)]"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </label>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {verificationUri && device ? (
          <a
            href={verificationUri}
            data-testid={`provider-open-${card.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className={SECONDARY}
            onClick={(event) => {
              event.preventDefault();
              window.open(verificationUri, "_blank", "noopener,noreferrer");
            }}
          >
            <NewTabLabel>Open device page</NewTabLabel>
          </a>
        ) : null}
        {verificationUri && !device ? (
          <a
            href={verificationUri}
            data-testid={`provider-authorize-${card.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className={SECONDARY}
          >
            <NewTabLabel>
              {card.connection.signInKind === "chatgpt-pkce"
                ? "Open ChatGPT sign-in"
                : "Open sign-in"}
            </NewTabLabel>
          </a>
        ) : null}
        {codexAuthorization && typeof window !== "undefined" && window.shibaDesktop ? (
          <button
            type="button"
            data-testid={`provider-receive-${card.id}`}
            disabled={busy}
            onClick={() => {
              setDesktopError(null);
              void window.shibaDesktop?.receiveCodexCallback(codexAuthorization).then((result) => {
                if (result.ok) onVerify(card.id, { callbackUrl: result.callbackUrl });
                else setDesktopError(result.error);
              });
            }}
            className={SECONDARY}
          >
            Receive callback on this computer
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy || (needsToken && credential.trim() === "")}
          onClick={finish}
          className={PRIMARY}
        >
          {actionLabel(busy, action, "verify", "Finish sign-in", "Checking…")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDisconnect(card.id)}
          className={SECONDARY}
        >
          {actionLabel(busy, action, "disconnect", "Cancel", "Working…")}
        </button>
      </div>
      {desktopError ? (
        <p className="mt-2 text-xs text-[var(--destructive)]" role="alert">
          {desktopError}
        </p>
      ) : null}
    </div>
  );
}

function DisconnectedActions({
  card,
  busy,
  action,
  onConnectOauth,
  onConnectSetupToken,
  onConnectApiKey,
}: {
  card: AcpProviderCard;
  busy: boolean;
  action: CardAction | null;
  onConnectOauth: (id: string) => void;
  onConnectSetupToken: (id: string) => void;
  onConnectApiKey: (id: string, credential?: string) => void;
}): JSX.Element {
  const [secret, setSecret] = useState("");
  const [desktopError, setDesktopError] = useState<string | null>(null);
  const pasteLabel = PASTE_KEY_LABEL[card.id];
  const claudeOnDesktop = desktopCanSignInClaude(
    typeof window === "undefined" ? undefined : window.shibaDesktop,
    card.id,
  );
  return (
    <div className="mt-3 flex flex-col gap-2">
      {pasteLabel ? (
        <label className="block">
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
            {pasteLabel}
          </span>
          <input
            type="password"
            data-testid={`provider-key-${card.id}`}
            className="mt-1 w-full border border-[var(--border-1)] bg-[var(--card)] p-2 font-mono text-[11px] text-[var(--fg)]"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            autoComplete="off"
            disabled={busy}
          />
        </label>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {card.capabilities.oauth ? (
          <button
            type="button"
            data-testid={`provider-connect-oauth-${card.id}`}
            disabled={busy}
            onClick={() => onConnectOauth(card.id)}
            className={PRIMARY}
          >
            {actionLabel(busy, action, "oauth", "Connect with sign-in", "Working…")}
          </button>
        ) : null}
        {claudeOnDesktop ? (
          <button
            type="button"
            data-testid="provider-claude-login"
            disabled={busy}
            onClick={() => {
              setDesktopError(null);
              void window.shibaDesktop?.startClaudeLogin().then((result) => {
                if (result.ok) onConnectOauth(card.id);
                else setDesktopError(result.error);
              });
            }}
            className={SECONDARY}
          >
            {actionLabel(busy, action, "oauth", "Sign in with Claude Code", "Working…")}
          </button>
        ) : null}
        {card.id === "claude" ? (
          <button
            type="button"
            data-testid="provider-connect-setup-token-claude"
            disabled={busy}
            onClick={() => onConnectSetupToken(card.id)}
            className={SECONDARY}
          >
            {actionLabel(busy, action, "setup-token", "Use setup-token (opt-in)", "Checking…")}
          </button>
        ) : null}
        {card.capabilities.apiKey ? (
          <button
            type="button"
            data-testid={`provider-connect-key-${card.id}`}
            disabled={busy || (pasteLabel !== undefined && secret.trim() === "")}
            onClick={() => onConnectApiKey(card.id, pasteLabel ? secret.trim() : undefined)}
            className={card.capabilities.oauth ? SECONDARY : PRIMARY}
          >
            {actionLabel(busy, action, "api-key", "Use API credential", "Working…")}
          </button>
        ) : null}
      </div>
      {desktopError ? (
        <p className="text-xs text-[var(--destructive)]" role="alert">
          {desktopError}
        </p>
      ) : null}
    </div>
  );
}

function ConnectedActions({
  card,
  busy,
  action,
  onTest,
  onDisconnect,
  onDefault,
}: {
  card: AcpProviderCard;
  busy: boolean;
  action: CardAction | null;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid={`provider-test-${card.id}`}
        disabled={busy}
        onClick={() => onTest(card.id)}
        className={PRIMARY}
      >
        {actionLabel(busy, action, "test", "Test connection", "Testing…")}
      </button>
      {card.isDefault ? null : (
        <button
          type="button"
          data-testid={`provider-default-${card.id}`}
          disabled={busy}
          onClick={() => onDefault(card.id)}
          className={SECONDARY}
        >
          {actionLabel(busy, action, "default", "Set as org default", "Working…")}
        </button>
      )}
      <button
        type="button"
        data-testid={`provider-disconnect-${card.id}`}
        disabled={busy}
        onClick={() => onDisconnect(card.id)}
        className={SECONDARY}
      >
        {actionLabel(busy, action, "disconnect", "Disconnect", "Working…")}
      </button>
    </div>
  );
}

function ProviderActions(props: {
  card: AcpProviderCard;
  busy: boolean;
  action: CardAction | null;
  onConnectOauth: (id: string) => void;
  onConnectSetupToken: (id: string) => void;
  onConnectApiKey: (id: string, credential?: string) => void;
  onVerify: (id: string, body: Record<string, string>) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  const { card, action } = props;
  if (card.connection.phase === "waiting") {
    return (
      <WaitingSignIn
        card={card}
        busy={props.busy}
        action={action}
        onVerify={props.onVerify}
        onDisconnect={props.onDisconnect}
      />
    );
  }
  if (card.connection.phase === "connected") {
    return (
      <ConnectedActions
        card={card}
        busy={props.busy}
        action={action}
        onTest={props.onTest}
        onDisconnect={props.onDisconnect}
        onDefault={props.onDefault}
      />
    );
  }
  return (
    <DisconnectedActions
      card={card}
      busy={props.busy}
      action={action}
      onConnectOauth={props.onConnectOauth}
      onConnectSetupToken={props.onConnectSetupToken}
      onConnectApiKey={props.onConnectApiKey}
    />
  );
}

function ProviderCard({
  card,
  index,
  busy,
  action,
  onConnectOauth,
  onConnectSetupToken,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  card: AcpProviderCard;
  index: number;
  busy: boolean;
  action: CardAction | null;
  onConnectOauth: (id: string) => void;
  onConnectSetupToken: (id: string) => void;
  onConnectApiKey: (id: string, credential?: string) => void;
  onVerify: (id: string, body: Record<string, string>) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  const phase = providerPhaseLabel(card.connection);
  const ordinal = String(index + 1).padStart(2, "0");
  return (
    <article
      data-testid={`provider-card-${card.id}`}
      aria-busy={busy}
      className="flex min-w-0 flex-col border border-[var(--border-1)] bg-[var(--card)] shadow-[var(--sh-card)]"
    >
      <header className="flex items-center justify-between gap-3 border-b border-[var(--border-1)] bg-[var(--panel)] px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-mono text-[10px] tabular-nums text-[var(--muted-foreground-3)]">
            {ordinal}
          </span>
          <h4 className="truncate text-[13px] font-semibold text-[var(--fg)]">{card.label}</h4>
          {card.isDefault ? (
            <span className="shrink-0 border border-[var(--primary)]/30 bg-[var(--primary-soft)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--primary)]">
              Default
            </span>
          ) : null}
        </div>
        <span data-testid={`provider-status-${card.id}`} className="shrink-0">
          <ToneChip tone={phase.tone} label={phase.label} />
        </span>
      </header>

      <div className="flex flex-1 flex-col px-3 py-3">
        <p className="text-xs leading-relaxed text-[var(--muted-foreground-2)]">{card.blurb}</p>
        {card.connection.message ? (
          <p
            data-testid={`provider-signin-message-${card.id}`}
            className="mt-2 font-mono text-[11px] leading-relaxed text-[var(--fg)]"
          >
            {card.connection.message}
          </p>
        ) : null}
        {card.connection.phase === "waiting" ? null : (
          <OperatorSteps id={card.id} steps={card.connection.operatorSteps ?? []} />
        )}
        <ProviderActions
          card={card}
          busy={busy}
          action={action}
          onConnectOauth={onConnectOauth}
          onConnectSetupToken={onConnectSetupToken}
          onConnectApiKey={onConnectApiKey}
          onVerify={onVerify}
          onTest={onTest}
          onDisconnect={onDisconnect}
          onDefault={onDefault}
        />
      </div>

      <footer className="mt-auto flex min-w-0 flex-wrap gap-px border-t border-[var(--border-1)] bg-[var(--border-1)] font-mono text-[10px] text-[var(--muted-foreground-2)]">
        <Fact label="Lane" value={card.capabilities.acp ? "ACP" : "CLI"} />
        <Fact label="Harness" value={card.harness} />
        <Fact label="Model" value={card.defaultModel} />
        <a
          href={card.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ml-auto inline-flex min-h-6 touch:min-h-11 items-center bg-[var(--card)] px-2.5 py-1.5 uppercase tracking-[0.12em] text-[var(--primary)] hover:bg-[var(--panel)]"
        >
          <NewTabLabel>Docs</NewTabLabel>
        </a>
      </footer>
    </article>
  );
}

async function postProvider(
  path: string,
  body: Record<string, unknown>,
): Promise<AcpProvidersSnapshot> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Request failed (${response.status}).`);
  }
  const payload = (await response.json()) as AcpProvidersSnapshot;
  if (!Array.isArray(payload.providers)) {
    throw new Error("Provider status was not returned.");
  }
  return payload;
}

function AdapterBody({
  snapshot,
  loading,
  busyId,
  busyAction = null,
  onConnectOauth,
  onConnectSetupToken,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  snapshot: AcpProvidersSnapshot | null;
  loading: boolean;
  busyId: string | null;
  busyAction?: CardAction | null;
  onConnectOauth: (id: string) => void;
  onConnectSetupToken: (id: string) => void;
  onConnectApiKey: (id: string, credential?: string) => void;
  onVerify: (id: string, body: Record<string, string>) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  if (loading && snapshot === null) {
    return (
      <div data-testid="providers-loading" role="status" className="flex flex-col gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          Loading providers…
        </p>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          {["a", "b", "c", "d", "e"].map((key) => (
            <ProviderSkeleton key={key} />
          ))}
        </div>
      </div>
    );
  }
  const providers = snapshot?.providers ?? [];
  if (providers.length === 0) {
    return <EmptyState title="No adapters" detail="The registry returned no sandbox adapters." />;
  }
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      {providers.map((card, index) => (
        <ProviderCard
          key={card.id}
          card={card}
          index={index}
          busy={busyId === card.id}
          action={busyId === card.id ? busyAction : null}
          onConnectOauth={onConnectOauth}
          onConnectSetupToken={onConnectSetupToken}
          onConnectApiKey={onConnectApiKey}
          onVerify={onVerify}
          onTest={onTest}
          onDisconnect={onDisconnect}
          onDefault={onDefault}
        />
      ))}
    </div>
  );
}

export function ProvidersBoard({
  snapshot,
  loading,
  error,
  busyId,
  busyAction = null,
  actionError,
  onRetry,
  onConnectOauth,
  onConnectSetupToken,
  onConnectApiKey,
  onVerify,
  onTest,
  onDisconnect,
  onDefault,
}: {
  snapshot: AcpProvidersSnapshot | null;
  loading: boolean;
  error: string | null;
  busyId: string | null;
  busyAction?: CardAction | null;
  actionError: string | null;
  onRetry: () => void;
  onConnectOauth: (id: string) => void;
  onConnectSetupToken: (id: string) => void;
  onConnectApiKey: (id: string, credential?: string) => void;
  onVerify: (id: string, body: Record<string, string>) => void;
  onTest: (id: string) => void;
  onDisconnect: (id: string) => void;
  onDefault: (id: string) => void;
}): JSX.Element {
  const ready =
    snapshot?.providers.filter((provider) => provider.connection.phase === "connected").length ?? 0;
  const total = snapshot?.providers.length ?? 0;
  const defaultLabel = snapshot?.defaultProviderId
    ? (snapshot.providers.find((provider) => provider.id === snapshot.defaultProviderId)?.label ??
      snapshot.defaultProviderId)
    : null;

  return (
    <div
      data-testid="providers-page"
      className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--bg)] text-[var(--fg)]"
    >
      <PageHeader
        title="Providers"
        detail="Codex uses your ChatGPT plan. Claude pairs a computer or takes a setup token. Gemini (Antigravity), Grok, and Cursor support Connect with sign-in; OpenCode and API-key lanes still accept a pasted key. Credentials stay encrypted and attach at egress."
      >
        {defaultLabel ? (
          <span
            data-testid="providers-org-default"
            className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]"
          >
            Org default · {defaultLabel}
          </span>
        ) : null}
        <span className="border border-[var(--border-1)] bg-[var(--card)] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
          {snapshot ? `${ready} of ${total} connected` : "—"}
        </span>
      </PageHeader>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="mx-auto flex max-w-6xl flex-col gap-8">
          {error ? <LoadErrorState message={error} onRetry={onRetry} /> : null}
          {actionError ? (
            <div data-testid="providers-action-error">
              <StatusNotice tone="err">{actionError}</StatusNotice>
            </div>
          ) : null}

          {error && snapshot === null ? null : (
            <section className="flex flex-col gap-3">
              <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--border-1)] pb-2">
                <h3 className="text-sm font-semibold text-[var(--fg)]">Sandbox adapters</h3>
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                  Org default is recorded here. A run still uses the harness for that task.
                </p>
              </div>
              <AdapterBody
                snapshot={snapshot}
                loading={loading}
                busyId={busyId}
                busyAction={busyAction}
                onConnectOauth={onConnectOauth}
                onConnectSetupToken={onConnectSetupToken}
                onConnectApiKey={onConnectApiKey}
                onVerify={onVerify}
                onTest={onTest}
                onDisconnect={onDisconnect}
                onDefault={onDefault}
              />
            </section>
          )}

          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--border-1)] pb-2">
              <h3 className="text-sm font-semibold text-[var(--fg)]">Model connections</h3>
              <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]">
                Named credentials a run can route through.
              </p>
            </div>
            <ConnectionsCard />
          </section>
        </div>
      </div>
    </div>
  );
}

export function ProvidersView(): JSX.Element {
  const [snapshot, setSnapshot] = useState<AcpProvidersSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<CardAction | null>(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    const ticket = ++generation.current;
    setLoading(true);
    setBusyId(null);
    setBusyAction(null);
    const reload = attempt;
    void fetch("/api/providers", { cache: reload === 0 ? "default" : "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Providers request failed: ${response.status}`);
        const body = (await response.json()) as AcpProvidersSnapshot;
        if (ticket !== generation.current) return;
        setSnapshot(body);
        setError(null);
      })
      .catch((err: unknown) => {
        if (ticket !== generation.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (ticket === generation.current) setLoading(false);
      });
  }, [attempt]);

  const run = useCallback(
    async (id: string, action: CardAction, work: () => Promise<AcpProvidersSnapshot>) => {
      const ticket = ++generation.current;
      setBusyId(id);
      setBusyAction(action);
      setActionError(null);
      try {
        const next = await work();
        if (ticket !== generation.current) return;
        setSnapshot(next);
      } catch (err) {
        if (ticket !== generation.current) return;
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        if (ticket === generation.current) {
          setBusyId(null);
          setBusyAction(null);
        }
      }
    },
    [],
  );

  return (
    <ProvidersBoard
      snapshot={snapshot}
      loading={loading}
      error={error}
      busyId={busyId}
      busyAction={busyAction}
      actionError={actionError}
      onRetry={() => setAttempt((n) => n + 1)}
      onConnectOauth={(id) =>
        void run(id, "oauth", () => postProvider(`/api/providers/${id}/connect`, { mode: "oauth" }))
      }
      onConnectSetupToken={(id) =>
        void run(id, "setup-token", () =>
          postProvider(`/api/providers/${id}/connect`, { mode: "setup-token" }),
        )
      }
      onConnectApiKey={(id, credential) =>
        void run(id, "api-key", () =>
          postProvider(
            `/api/providers/${id}/connect`,
            credential ? { mode: "api-key", credential } : { mode: "api-key" },
          ),
        )
      }
      onVerify={(id, body) =>
        void run(id, "verify", () => postProvider(`/api/providers/${id}/verify`, body))
      }
      onTest={(id) => void run(id, "test", () => postProvider(`/api/providers/${id}/test`, {}))}
      onDisconnect={(id) =>
        void run(id, "disconnect", () => postProvider(`/api/providers/${id}/disconnect`, {}))
      }
      onDefault={(id) =>
        void run(id, "default", () => postProvider(`/api/providers/${id}/default`, {}))
      }
    />
  );
}
