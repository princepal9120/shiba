#!/usr/bin/env node
/**
 * OAuth loopback for local dev — Antigravity :51121, xAI :56121.
 * Started automatically by `pnpm dev` and `pnpm shiba dev`.
 */
import { OAUTH_LOOPBACK_BINDINGS, startAllOAuthLoopbackServers } from "./oauth-loopback-lib.mjs";

const servers = startAllOAuthLoopbackServers({
  onListen(port) {
    console.log(`[oauth-loopback] listening on http://127.0.0.1:${port}/callback`);
  },
});

function shutdown() {
  for (const server of servers) {
    server.close();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(
  `[oauth-loopback] ready (${OAUTH_LOOPBACK_BINDINGS.map((b) => b.port).join(", ")}) — OAuth redirects auto-notify the dashboard`,
);
