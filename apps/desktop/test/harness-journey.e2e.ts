/**
 * Desktop journey through the session harness: pair the real daemon, claim a
 * task, stream a Claude tool approval, approve it, render the diff, and open
 * a pull request against a mocked GitHub.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type ElectronApplication, _electron as electron } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";

const PR_URL = "https://github.com/acme/widgets/pull/9";

const FAKE_CLAUDE = `import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const rl = createInterface({ input: process.stdin });
let init = false;
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!init) {
    init = true;
    send({ type: "system", subtype: "init", session_id: "sess_e2e" });
  }
  if (msg.type === "user") {
    send({ type: "assistant", message: { content: [{ type: "text", text: "adding a greeting" }] } });
    send({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: { command: "write greeting.txt" } } });
    return;
  }
  if (msg.type === "control_response") {
    if (msg.response?.response?.behavior === "allow") {
      writeFileSync(join(process.cwd(), "greeting.txt"), "hello from shiba\\n");
    }
    send({ type: "result", result: "wrote greeting.txt", session_id: "sess_e2e" });
  }
});
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Shiba</title></head><body>
<main>
  <h1>Shiba</h1>
  <p id="daemon"></p>
  <button type="button" id="pair">Pair this computer</button>
  <form id="task">
    <textarea aria-label="Task description"></textarea>
    <button type="submit">Send task</button>
  </form>
  <section id="stream"></section>
  <section id="approval" hidden>
    <p id="approval-title"></p>
    <button type="button" id="allow">Allow</button>
  </section>
  <section id="diff-section" hidden>
    <h2>Pull requests</h2>
    <pre data-testid="diff"></pre>
    <button type="button" id="show">Show diff</button>
    <button type="button" id="pr">Open pull request</button>
  </section>
</main>
<script>
  const daemon = document.getElementById("daemon");
  const bridge = window.shibaDesktop;
  const paint = (status) => { if (status) daemon.textContent = status.state; };
  if (bridge) {
    bridge.status().then(paint);
    bridge.onStatus(paint);
  }
  document.getElementById("pair").addEventListener("click", () => {
    if (bridge) void bridge.pair("e2e.token");
  });
  document.getElementById("task").addEventListener("submit", (event) => {
    event.preventDefault();
    const task = document.querySelector("[aria-label='Task description']").value;
    void fetch("/api/e2e/task", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ task }) });
  });
  document.getElementById("allow").addEventListener("click", () => {
    document.getElementById("approval").hidden = true;
    void fetch("/api/e2e/decide", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision: "allow" }) });
  });
  document.getElementById("show").addEventListener("click", async () => {
    const patch = document.querySelector("[data-testid=diff]").textContent;
    if (bridge) await bridge.showDiff(patch);
  });
  document.getElementById("pr").addEventListener("click", async () => {
    const response = await fetch("/github/repos/acme/widgets/pulls", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const body = await response.json();
    if (bridge) void bridge.openPullRequest(body.html_url);
  });
  setInterval(async () => {
    const board = await fetch("/api/e2e/board").then((response) => response.json()).catch(() => null);
    if (!board) return;
    document.getElementById("stream").textContent = (board.events || []).map((event) => event.text).join("\\n");
    const waiting = (board.approvals || []).find((approval) => !approval.decision);
    if (waiting) {
      document.getElementById("approval").hidden = false;
      document.getElementById("approval-title").textContent = waiting.title;
    }
    if (board.diff) {
      document.getElementById("diff-section").hidden = false;
      document.querySelector("[data-testid=diff]").textContent = board.diff;
    }
  }, 400);
</script>
</body></html>`;

interface Approval {
  requestId: string;
  title: string;
  decision?: "allow" | "deny";
}
interface EventRow {
  text: string;
  patch?: string;
}

let stub: Server;
let stubUrl = "";
let repo = "";
let fake = "";
const userDataDirs: string[] = [];
const roots: string[] = [];

let task: string | null = null;
let claimed = false;
const events: EventRow[] = [];
const approvals: Approval[] = [];
let liveDiff = "";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function envelope() {
  return {
    version: 1,
    sandboxId: "e2e-harness",
    repoUrl: pathToFileURL(repo).href,
    baseBranch: "main",
    task: task ?? "Add a greeting",
    harness: "claude-code",
    cloneDir: `${"$"}{SHIBA_LOCAL_RUN_ROOT}/work`,
    homeDir: `${"$"}{SHIBA_LOCAL_RUN_ROOT}/home`,
    setupCommands: [],
    configFiles: [],
    argv: ["node", "unused"],
    env: {},
    execAllowlist: [["git"]],
    setupAllowlist: [["git"]],
    deadlineAt: Date.now() + 10 * 60 * 1000,
    createdAt: Date.now(),
    session: {
      provider: "claude",
      model: "claude",
      permissionMode: "approval-required",
      bin: process.execPath,
      binArgs: [fake],
    },
  };
}

beforeAll(async () => {
  const root = mkdtempSync(path.join(tmpdir(), "shiba-harness-e2e-"));
  roots.push(root);
  repo = path.join(root, "repo");
  fake = path.join(root, "fake-claude.mjs");
  writeFileSync(fake, FAKE_CLAUDE);
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "test"], { cwd: repo });
  writeFileSync(path.join(repo, "README"), "base\n");
  execFileSync("git", ["add", "README"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "base"], { cwd: repo });

  stub = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const body = req.method === "POST" ? await readBody(req) : "";
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      if (url.pathname === "/api/computers") return json(res, { computers: [] });
      if (url.pathname === "/api/approvals") return json(res, { approvals: [] });
      if (url.pathname === "/api/computers/revoke") return json(res, { ok: true });
      if (url.pathname === "/api/local/pair")
        return json(res, { adapterToken: "e2e-adapter", machineId: "machine-e2e" });
      if (url.pathname === "/api/local/heartbeat") return json(res, { ok: true });
      if (url.pathname === "/api/local/claim") {
        if (task === null || claimed) return json(res, { envelope: null });
        claimed = true;
        return json(res, { envelope: envelope(), claimToken: "claim-e2e" });
      }
      if (url.pathname === "/api/local/events") {
        const event = parsed.event as { text?: string; patch?: string } | undefined;
        if (event) {
          events.push({
            text: String(event.text ?? ""),
            ...(event.patch ? { patch: event.patch } : {}),
          });
          if (event.patch) liveDiff = event.patch;
        }
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/local/approval") {
        const request = parsed.request as { requestId?: string; title?: string } | undefined;
        if (request?.requestId && !approvals.some((item) => item.requestId === request.requestId)) {
          approvals.push({
            requestId: request.requestId,
            title: String(request.title ?? "approval"),
          });
        }
        const requestId = typeof parsed.requestId === "string" ? parsed.requestId : "";
        const found = approvals.find((item) => item.requestId === requestId);
        return json(res, found?.decision ? { decision: found.decision } : { pending: true });
      }
      if (url.pathname === "/api/local/control") return json(res, { interrupt: false });
      if (url.pathname === "/api/local/result") return json(res, { ok: true });
      if (url.pathname === "/api/e2e/task") {
        task = typeof parsed.task === "string" ? parsed.task : "Add a greeting";
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/e2e/decide") {
        for (const approval of approvals) {
          if (!approval.decision) approval.decision = parsed.decision === "deny" ? "deny" : "allow";
        }
        return json(res, { ok: true });
      }
      if (url.pathname === "/api/e2e/board")
        return json(res, { events, approvals, diff: liveDiff });
      if (url.pathname === "/github/repos/acme/widgets/pulls")
        return json(res, { html_url: PR_URL });
      if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
        res.setHeader("content-type", "text/html");
        res.end(PAGE);
        return;
      }
      res.statusCode = 404;
      res.end("not found");
    })().catch((error) => {
      res.statusCode = 500;
      res.end(error instanceof Error ? error.message : "error");
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true });
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

test("pair, stream a harness approval, render the diff, and open a pull request", async () => {
  const userData = mkdtempSync(path.join(tmpdir(), "shiba-harness-electron-"));
  const runRoot = mkdtempSync(path.join(tmpdir(), "shiba-harness-root-"));
  userDataDirs.push(userData, runRoot);
  const app: ElectronApplication = await electron.launch({
    args: ["dist/main.js", `--user-data-dir=${userData}`],
    env: {
      ...(process.env as Record<string, string>),
      SHIBA_DESKTOP_URL: stubUrl,
      SHIBA_LOCAL_RUN_ROOT: runRoot,
    },
  });
  try {
    const win = await app.firstWindow();
    win.setDefaultTimeout(10_000);
    await win.waitForURL(`${stubUrl}/app/**`, { timeout: 20_000 });
    await expect
      .poll(async () => win.locator("#daemon").textContent(), { timeout: 20_000 })
      .toBe("unpaired");
    await win.getByRole("button", { name: "Pair this computer" }).click();
    await expect
      .poll(async () => win.locator("#daemon").textContent(), { timeout: 20_000 })
      .toBe("idle");

    await win.getByLabel("Task description").fill("Add a greeting");
    await win.getByRole("button", { name: "Send task" }).click();
    await expect
      .poll(async () => win.locator("#stream").textContent(), { timeout: 20_000 })
      .toContain("adding a greeting");
    // The approval title is the tool command the adapter asked to run.
    await expect
      .poll(async () => win.locator("#approval-title").textContent(), { timeout: 10_000 })
      .toContain("write greeting.txt");
    await win.getByRole("button", { name: "Allow" }).click();
    await expect
      .poll(async () => win.getByTestId("diff").textContent(), { timeout: 20_000 })
      .toContain("greeting.txt");

    const diffWindow = app.waitForEvent("window");
    await win.getByRole("button", { name: "Show diff" }).click();
    const patch = await diffWindow;
    await expect
      .poll(async () => patch.locator("#patch").textContent(), { timeout: 10_000 })
      .toContain("greeting.txt");

    await app.evaluate(({ shell }) => {
      const g = globalThis as { __opened?: string[] };
      g.__opened = [];
      shell.openExternal = async (url: string) => {
        g.__opened?.push(url);
      };
    });
    await win.getByRole("button", { name: "Open pull request" }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []), {
        timeout: 10_000,
      })
      .toContain(PR_URL);
  } finally {
    await app.close();
  }
}, 70_000);
