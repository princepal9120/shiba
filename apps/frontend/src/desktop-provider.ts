/** Authorize hosts whose loopback redirect this computer can receive. */
const LOOPBACK_PROVIDERS: readonly {
  hosts: readonly string[];
  callbackPath: string;
  port: number | null;
}[] = [
  { hosts: ["auth.openai.com"], callbackPath: "/auth/callback", port: null },
  { hosts: ["accounts.google.com"], callbackPath: "/callback", port: 51121 },
  { hosts: ["auth.x.ai", "accounts.x.ai"], callbackPath: "/callback", port: 56121 },
];

/** True when the desktop shell can receive this PKCE authorize URL on loopback. */
export function desktopCodexAuthorizationUrl(value: string | null | undefined): string | null {
  if (!value || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const provider = LOOPBACK_PROVIDERS.find((item) => item.hosts.includes(url.hostname));
  if (!provider || url.protocol !== "https:" || url.username || url.password) return null;
  if (
    !url.searchParams.get("code_challenge") ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    return null;
  }
  const redirect = url.searchParams.get("redirect_uri");
  if (!redirect) return null;
  let redir: URL;
  try {
    redir = new URL(redirect);
  } catch {
    return null;
  }
  const port = Number(redir.port);
  if (
    redir.protocol !== "http:" ||
    redir.hostname !== "127.0.0.1" ||
    redir.pathname !== provider.callbackPath ||
    !Number.isInteger(port) ||
    port < 1024 ||
    (provider.port !== null && port !== provider.port)
  ) {
    return null;
  }
  return url.toString();
}

export function desktopCanSignInClaude(
  bridge: { startClaudeLogin?: unknown } | undefined,
  providerId: string,
): boolean {
  return providerId === "claude" && typeof bridge?.startClaudeLogin === "function";
}
