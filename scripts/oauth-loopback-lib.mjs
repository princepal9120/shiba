/**
 * Local OAuth loopback listeners for Antigravity (51121) and xAI (56121).
 * Callback URLs are forwarded to the local Worker for dashboard polling.
 */
import { createServer } from "node:http";

export const SHIBA_OAUTH_CALLBACK_MESSAGE = "shiba-oauth-callback";

export const DEV_OAUTH_LOOPBACK_HEADER = "x-shiba-dev-oauth-loopback-secret";

const DEFAULT_WORKER_URL = "http://127.0.0.1:8788";

/** @type {readonly { port: number; pathname: string }[]} */
export const OAUTH_LOOPBACK_BINDINGS = [
  { port: 51121, pathname: "/callback" },
  { port: 56121, pathname: "/callback" },
];

/**
 * @param {string} callbackUrl
 * @returns {Promise<void>}
 */
export async function notifyWorkerOAuthCallback(callbackUrl) {
  const base = (process.env.SHIBA_WORKER_URL ?? DEFAULT_WORKER_URL).replace(/\/$/, "");
  const secret = process.env.SHIBA_DEV_OAUTH_LOOPBACK_SECRET?.trim() ?? "";
  const headers = { "content-type": "application/json" };
  if (secret !== "") {
    headers[DEV_OAUTH_LOOPBACK_HEADER] = secret;
  }
  try {
    const response = await fetch(`${base}/api/dev/oauth-loopback`, {
      method: "POST",
      headers,
      body: JSON.stringify({ url: callbackUrl }),
    });
    if (!response.ok) {
      console.warn(`[oauth-loopback] Worker notify → ${response.status}`);
    }
  } catch (error) {
    console.warn(`[oauth-loopback] Worker notify failed: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * @param {string} callbackUrl
 * @returns {string}
 */
export function oauthCallbackSuccessHtml(callbackUrl) {
  const safe = JSON.stringify(callbackUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Shiba sign-in</title></head>
<body>
<p>Sign-in complete. Return to the Shiba dashboard — this tab can close.</p>
<script>
(function () {
  var url = ${safe};
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage({ type: ${JSON.stringify(SHIBA_OAUTH_CALLBACK_MESSAGE)}, url: url }, "*");
    }
  } catch (e) {}
})();
</script>
</body>
</html>`;
}

/**
 * @param {{ port: number; pathname?: string; onHit?: (url: string) => void }} opts
 * @returns {import("node:http").Server}
 */
export function startOAuthLoopbackServer({ port, pathname = "/callback", onHit } = {}) {
  const server = createServer((req, res) => {
    const host = req.headers.host ?? `127.0.0.1:${port}`;
    const pathOnly = (req.url ?? "/").split("?")[0] ?? "/";
    if (pathOnly !== pathname) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }
    const callbackUrl = `http://${host}${req.url ?? ""}`;
    onHit?.(callbackUrl);
    void notifyWorkerOAuthCallback(callbackUrl);
    const body = oauthCallbackSuccessHtml(callbackUrl);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
  });
  server.on("error", (error) => {
    if (error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE") {
      console.warn(`[oauth-loopback] port ${port} already in use — assuming another loopback process is running`);
      return;
    }
    console.error(`[oauth-loopback] port ${port}:`, error);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/**
 * @param {{ onListen?: (port: number) => void; onHit?: (url: string) => void }} [opts]
 * @returns {import("node:http").Server[]}
 */
export function startAllOAuthLoopbackServers(opts = {}) {
  return OAUTH_LOOPBACK_BINDINGS.map(({ port, pathname }) => {
    const server = startOAuthLoopbackServer({
      port,
      pathname,
      onHit: opts.onHit,
    });
    server.on("listening", () => opts.onListen?.(port));
    return server;
  });
}
