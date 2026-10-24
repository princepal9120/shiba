/**
 * Hosted-shell journey against a loopback stand-in for app.tryshiba.dev.
 * The page uses the same accessible names as the dashboard composer, approval
 * card, diff, and pull request. The shell's bridge pairs the session probe,
 * opens the diff window, and hands the pull URL to the OS.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { type ElectronApplication, _electron as electron } from "playwright-core";
import { afterAll, beforeAll, expect, test } from "vitest";

const PATCH = "diff --git a/src/cart.ts b/src/cart.ts\n@@ -1 +1 @@\n-old\n+new\n";
const PR_URL = "https://github.com/acme/widgets/pull/7";

const JOURNEY = `<!doctype html><html><head><meta charset="utf-8"><title>Shiba</title></head><body>
<main>
  <h1>Shiba</h1>
  <p id="daemon"></p>
  <form id="task">
    <textarea aria-label="Task description"></textarea>
    <button type="submit" aria-label="Send task">Send task</button>
  </form>
  <section id="approval" hidden>
    <p>Approve to start the run</p>
    <button type="button" id="approve">Approve</button>
  </section>
  <section id="diff" hidden>
    <h2>Pull requests</h2>
    <pre data-testid="diff"></pre>
    <button type="button" id="pr">Open pull request</button>
  </section>
</main>
<script>
  const daemon = document.getElementById("daemon");
  const bridge = window.shibaDesktop;
  if (bridge) {
    const paint = (status) => { daemon.textContent = status.state; };
    bridge.status().then(paint);
    bridge.onStatus(paint);
  }
  document.getElementById("task").addEventListener("submit", (event) => {
    event.preventDefault();
    document.getElementById("approval").hidden = false;
  });
  document.getElementById("approve").addEventListener("click", async () => {
    document.getElementById("approval").hidden = true;
    const diff = document.getElementById("diff");
    diff.hidden = false;
    document.querySelector("[data-testid=diff]").textContent = ${JSON.stringify(PATCH)};
    if (bridge) await bridge.showDiff(${JSON.stringify(PATCH)});
    if (location.search.indexOf("tab=diff") === -1) history.replaceState(null, "", "/app/?tab=diff");
  });
  document.getElementById("pr").addEventListener("click", () => {
    if (bridge) void bridge.openPullRequest(${JSON.stringify(PR_URL)});
  });
</script>
</body></html>`;

let stub: Server;
let stubUrl = "";
const userDataDirs: string[] = [];

beforeAll(async () => {
  stub = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/computers") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ computers: [] }));
      return;
    }
    if (url.pathname === "/api/approvals") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ approvals: [] }));
      return;
    }
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      res.setHeader("content-type", "text/html");
      res.end(JOURNEY);
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => stub.close(resolve));
  for (const dir of userDataDirs) rmSync(dir, { recursive: true, force: true });
});

function launch(): Promise<ElectronApplication> {
  const userData = mkdtempSync(path.join(tmpdir(), "shiba-journey-"));
  userDataDirs.push(userData);
  return electron.launch({
    args: ["dist/main.js", `--user-data-dir=${userData}`],
    env: { ...(process.env as Record<string, string>), SHIBA_DESKTOP_URL: stubUrl },
  });
}

test("sign in, pair probe, approve, show the diff, and open a pull request", async () => {
  const app = await launch();
  try {
    const win = await app.firstWindow();
    await win.waitForURL(`${stubUrl}/app/**`);
    await expect
      .poll(async () => win.locator("#daemon").textContent(), { timeout: 20_000 })
      .toBe("unpaired");

    await win.getByLabel("Task description").fill("Add a greeting");
    await win.getByRole("button", { name: "Send task" }).click();
    await win.getByRole("button", { name: "Approve" }).click();
    await expect.poll(async () => win.getByTestId("diff").textContent()).toBe(PATCH);
    await expect.poll(() => win.url()).toContain("tab=diff");

    const diffWindow = await app.waitForEvent("window");
    await expect.poll(async () => diffWindow.locator("#patch").textContent()).toBe(PATCH);

    await app.evaluate(({ shell }) => {
      const g = globalThis as { __opened?: string[] };
      g.__opened = [];
      shell.openExternal = async (url: string) => {
        g.__opened?.push(url);
      };
    });
    await win.getByRole("button", { name: "Open pull request" }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { __opened?: string[] }).__opened ?? []))
      .toContain(PR_URL);
  } finally {
    await app.close();
  }
});
