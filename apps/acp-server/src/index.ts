/**
 * `shiba-acp` — Shiba as an installable ACP agent.
 *
 *   shiba-acp            (default) serve ACP over stdio
 *   shiba-acp serve      same, explicit
 *   shiba-acp login      mint SHIBA_TOKEN via email/password sign-in
 *
 * Config: SHIBA_URL (deployment origin, e.g. https://app.tryshiba.dev) and
 * SHIBA_TOKEN (better-auth session token — `login` prints one).
 */
import { createInterface } from "node:readline";
import { ShibaClient } from "./client.js";
import { JsonRpcPeer, parseJsonRpc } from "./jsonrpc.js";
import { ShibaAcpServer } from "./server.js";

const VERSION = "0.1.0";

function config(): { baseUrl: string; token: string } {
  const baseUrl = process.env.SHIBA_URL;
  const token = process.env.SHIBA_TOKEN;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    process.stderr.write("shiba-acp: SHIBA_URL is unset — point it at your deployment (e.g. https://app.tryshiba.dev)\n");
    process.exit(2);
  }
  if (token === undefined || token.trim() === "") {
    process.stderr.write("shiba-acp: SHIBA_TOKEN is unset — run `shiba-acp login` to mint one\n");
    process.exit(2);
  }
  return { baseUrl, token };
}

async function serve(): Promise<void> {
  const { baseUrl, token } = config();
  const client = new ShibaClient({ baseUrl, token });
  const peer = new JsonRpcPeer((msg) => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  });
  const server = new ShibaAcpServer({ client, peer, version: VERSION });

  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const msg = parseJsonRpc(line);
    if (msg === null) return;
    void server.handle(msg).catch((error) => {
      process.stderr.write(`shiba-acp: handler error: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  });
  rl.on("close", () => {
    peer.rejectAll("stdin closed");
    process.exit(0);
  });
}

async function login(): Promise<void> {
  const baseUrl = process.env.SHIBA_URL;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    process.stderr.write("shiba-acp: set SHIBA_URL first (e.g. https://app.tryshiba.dev)\n");
    process.exit(2);
  }
  const email = process.env.SHIBA_EMAIL ?? process.argv[3];
  const password = process.env.SHIBA_PASSWORD ?? process.argv[4];
  if (email === undefined || password === undefined) {
    process.stderr.write(
      "usage: SHIBA_URL=<origin> shiba-acp login <email> <password>\n" +
        "   or: SHIBA_EMAIL=… SHIBA_PASSWORD=… shiba-acp login\n",
    );
    process.exit(2);
  }
  const client = new ShibaClient({ baseUrl, token: "" });
  const token = await client.login(email, password);
  process.stdout.write(`${token}\n`);
  process.stderr.write("export it: export SHIBA_TOKEN=<token> (the session token, valid until sign-out)\n");
}

const command = process.argv[2] ?? "serve";
if (command === "serve") {
  void serve();
} else if (command === "login") {
  login().catch((error) => {
    process.stderr.write(`shiba-acp: login failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(`shiba-acp: unknown command ${JSON.stringify(command)} — serve | login\n`);
  process.exit(2);
}
