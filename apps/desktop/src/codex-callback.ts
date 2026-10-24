import { createServer, type Server } from "node:http";

const STATE_PATTERN = /^[A-Za-z0-9._~-]{8,256}$/;
export const CODEX_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

/** Loopback redirects this computer can receive. Ports for Antigravity and xAI are fixed. */
const LOOPBACK_PROVIDERS: readonly {
  hosts: readonly string[];
  callbackPath: string;
  port: number | null;
}[] = [
  { hosts: ["auth.openai.com"], callbackPath: "/auth/callback", port: null },
  { hosts: ["accounts.google.com"], callbackPath: "/callback", port: 51121 },
  { hosts: ["auth.x.ai", "accounts.x.ai"], callbackPath: "/callback", port: 56121 },
];

export interface CodexAuthorization {
  authorizationUrl: string;
  redirectUri: string;
  state: string;
  port: number;
  callbackPath: string;
}

export type CodexAuthorizationParse =
  | { ok: true; request: CodexAuthorization }
  | { ok: false; error: string };

export function parseCodexAuthorizationUrl(value: string): CodexAuthorizationParse {
  if (value.length === 0 || value.length > 4096) {
    return { ok: false, error: "ChatGPT sign-in URL is not valid." };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, error: "ChatGPT sign-in URL is not valid." };
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    return { ok: false, error: "ChatGPT sign-in must start at https://auth.openai.com." };
  }
  const provider = LOOPBACK_PROVIDERS.find((item) => item.hosts.includes(url.hostname));
  if (!provider) {
    return { ok: false, error: "ChatGPT sign-in must start at https://auth.openai.com." };
  }
  if (
    !url.searchParams.has("code_challenge") ||
    url.searchParams.get("code_challenge_method") !== "S256"
  ) {
    return { ok: false, error: "ChatGPT sign-in is missing PKCE." };
  }
  const state = url.searchParams.get("state") ?? "";
  if (!STATE_PATTERN.test(state)) {
    return { ok: false, error: "ChatGPT sign-in state is not valid." };
  }
  const redirect = url.searchParams.get("redirect_uri") ?? "";
  const redirectParsed = parseLoopbackRedirect(redirect, provider);
  if (!redirectParsed) {
    return {
      ok: false,
      error:
        provider.port === null
          ? "ChatGPT sign-in must redirect to http://127.0.0.1:<port>/auth/callback."
          : `Sign-in must redirect to http://127.0.0.1:${provider.port}${provider.callbackPath}.`,
    };
  }
  return {
    ok: true,
    request: {
      authorizationUrl: url.toString(),
      redirectUri: redirectParsed.href,
      state,
      port: redirectParsed.port,
      callbackPath: provider.callbackPath,
    },
  };
}

export function parseLoopbackCallback(value: string, expected?: CodexAuthorization): string | null {
  if (value.length === 0 || value.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  const allowed = expected
    ? url.pathname === expected.callbackPath && port === expected.port
    : LOOPBACK_PROVIDERS.some(
        (item) =>
          url.pathname === item.callbackPath && (item.port === null || item.port === port),
      );
  if (!allowed) return null;
  const state = url.searchParams.get("state") ?? "";
  if (!STATE_PATTERN.test(state)) return null;
  if (!url.searchParams.get("code") && !url.searchParams.get("error")) return null;
  if (expected && state !== expected.state) return null;
  url.hash = "";
  return url.toString();
}

function parseLoopbackRedirect(
  value: string,
  provider: (typeof LOOPBACK_PROVIDERS)[number],
): { href: string; port: number } | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== provider.callbackPath
  ) {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
  if (provider.port !== null && port !== provider.port) return null;
  return { href: url.origin + url.pathname, port };
}

interface Waiter {
  request: CodexAuthorization;
  resolve: (callbackUrl: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  server: Server;
}

const waiters = new Map<string, Waiter>();

export function cancelCodexCallback(authorizationUrl: string): void {
  const parsed = parseCodexAuthorizationUrl(authorizationUrl);
  if (!parsed.ok) return;
  const waiter = waiters.get(parsed.request.state);
  if (!waiter) return;
  fail(waiter, new Error("Sign-in cancelled on this computer."));
}

/** Resolves a waiting PKCE sign-in when a deep link carries the loopback callback. */
export function submitCodexCallback(callbackUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return false;
  }
  const state = url.searchParams.get("state") ?? "";
  const waiter = waiters.get(state);
  if (!waiter) return false;
  const accepted = parseLoopbackCallback(callbackUrl, waiter.request);
  if (!accepted) return false;
  succeed(waiter, accepted);
  return true;
}

export async function receiveCodexCallback(
  authorizationUrl: string,
  openBrowser: (url: string) => Promise<boolean>,
  timeoutMs = CODEX_CALLBACK_TIMEOUT_MS,
): Promise<string> {
  const parsed = parseCodexAuthorizationUrl(authorizationUrl);
  if (!parsed.ok) throw new Error(parsed.error);
  const { request } = parsed;
  if (waiters.has(request.state)) {
    throw new Error("This sign-in is already open on this computer.");
  }
  const server = createServer((incoming, response) => {
    const waiter = waiters.get(request.state);
    const host = `http://127.0.0.1:${request.port}`;
    const accepted =
      waiter && incoming.method === "GET"
        ? parseLoopbackCallback(`${host}${incoming.url ?? "/"}`, request)
        : null;
    response.setHeader("cache-control", "no-store");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
    );
    if (!waiter || !accepted) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("This response does not belong to the active sign-in.");
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      '<!doctype html><html><head><meta charset="utf-8"><title>Shiba</title></head><body><h1>Return to Shiba</h1><p>Sign-in was received. You can close this tab.</p></body></html>',
    );
    succeed(waiter, accepted);
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => {
        reject(new Error("The ChatGPT callback port is in use on this computer."));
      });
      server.listen(request.port, "127.0.0.1", () => resolve());
    });
  } catch (error) {
    server.close();
    throw error;
  }

  const callback = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiter = waiters.get(request.state);
      if (waiter) fail(waiter, new Error("Sign-in expired. Try again."));
    }, timeoutMs);
    waiters.set(request.state, { request, resolve, reject, timer, server });
  });
  void callback.catch(() => undefined);

  try {
    if (!(await openBrowser(request.authorizationUrl))) {
      const waiter = waiters.get(request.state);
      if (waiter) fail(waiter, new Error("Could not open your sign-in browser."));
    }
    return await callback;
  } catch (error) {
    const waiter = waiters.get(request.state);
    if (waiter) fail(waiter, error instanceof Error ? error : new Error("ChatGPT sign-in failed."));
    throw error instanceof Error ? error : new Error("ChatGPT sign-in failed.");
  }
}

function succeed(waiter: Waiter, callbackUrl: string): void {
  cleanup(waiter);
  waiter.resolve(callbackUrl);
}

function fail(waiter: Waiter, error: Error): void {
  cleanup(waiter);
  waiter.reject(error);
}

function cleanup(waiter: Waiter): void {
  if (waiters.get(waiter.request.state) !== waiter) return;
  waiters.delete(waiter.request.state);
  clearTimeout(waiter.timer);
  waiter.server.closeAllConnections();
  waiter.server.close();
}
