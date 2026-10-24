import { describe, expect, it, vi } from "vitest";
import { registerShellIpc, type ShellIpcDeps } from "../src/shell-ipc.js";

const ORIGIN = "https://app.tryshiba.dev";
const PATCH = "diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function makeDeps(overrides: Partial<ShellIpcDeps> = {}) {
  const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  const deps: ShellIpcDeps = {
    ipcMain: {
      handle: (channel: string, fn: (event: never, ...args: never[]) => unknown) => {
        handlers.set(channel, fn as never);
      },
    },
    isTrustedSender: (frame, origin) => frame === `${origin}/app/`,
    getConfiguredOrigin: () => ORIGIN,
    isDiffSender: (frame) => frame === "file:///diff.html",
    loadDashboardPath: vi.fn(),
    openExternal: vi.fn(async () => undefined),
    presentDiff: vi.fn(),
    readDiffPatch: () => PATCH,
    receiveCodex: vi.fn(async () => "http://127.0.0.1:1455/auth/callback?code=c&state=state-state"),
    cancelCodex: vi.fn(),
    startClaudeLogin: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
  registerShellIpc(deps);
  return { deps, handlers };
}

const invoke = (
  handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown>,
  channel: string,
  frameUrl: string | undefined,
  ...args: unknown[]
) => handlers.get(channel)?.({ senderFrame: { url: frameUrl } }, ...args);

describe("shell ipc", () => {
  it("rejects an untrusted sender for provider login, diff, and pull requests", async () => {
    const { deps, handlers } = makeDeps();
    expect(await invoke(handlers, "desktop:claude-login", "https://evil.example/")).toEqual({
      ok: false,
      error: "Untrusted sender.",
    });
    expect(await invoke(handlers, "desktop:show-diff", "https://evil.example/", PATCH)).toEqual({
      ok: false,
      error: "Untrusted sender.",
    });
    expect(
      await invoke(
        handlers,
        "desktop:open-pr",
        "https://evil.example/",
        "https://github.com/a/b/pull/1",
      ),
    ).toEqual({
      ok: false,
      error: "Untrusted sender.",
    });
    expect(deps.startClaudeLogin).not.toHaveBeenCalled();
    expect(deps.presentDiff).not.toHaveBeenCalled();
    expect(deps.openExternal).not.toHaveBeenCalled();
  });

  it("rejects desktop:codex-callback from an untrusted frame", async () => {
    const { deps, handlers } = makeDeps();
    expect(
      await invoke(
        handlers,
        "desktop:codex-callback",
        "https://evil.example/",
        "https://auth.openai.com/oauth/authorize",
      ),
    ).toEqual({ ok: false, error: "Untrusted sender." });
    expect(deps.receiveCodex).not.toHaveBeenCalled();
  });

  it("opens a dashboard view and a github pull request", async () => {
    const { deps, handlers } = makeDeps();
    await invoke(handlers, "desktop:open-view", `${ORIGIN}/app/`, "approvals");
    expect(deps.loadDashboardPath).toHaveBeenCalledWith("/app/?tab=approvals");
    const opened = await invoke(
      handlers,
      "desktop:open-pr",
      `${ORIGIN}/app/`,
      "https://github.com/acme/widgets/pull/4?w=1",
    );
    expect(opened).toEqual({ ok: true, url: "https://github.com/acme/widgets/pull/4" });
    expect(deps.openExternal).toHaveBeenCalledWith("https://github.com/acme/widgets/pull/4");
  });

  it("summarizes a patch and presents it, and only the diff frame can read it", () => {
    const { deps, handlers } = makeDeps();
    expect(invoke(handlers, "desktop:show-diff", `${ORIGIN}/app/`, PATCH)).toEqual({
      ok: true,
      files: ["a.ts"],
      hunks: 1,
      additions: 1,
      deletions: 1,
    });
    expect(deps.presentDiff).toHaveBeenCalledWith(PATCH);
    expect(invoke(handlers, "desktop:diff-payload", `${ORIGIN}/app/`)).toBe("");
    expect(invoke(handlers, "desktop:diff-payload", "file:///diff.html")).toBe(PATCH);
  });
});
