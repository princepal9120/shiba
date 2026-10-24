import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { ClaudeSpawn } from "../src/claude-login.js";
import {
  CLAUDE_LOGIN_ARGS,
  CLAUDE_LOGIN_COMMAND,
  CLAUDE_STATUS_ARGS,
  claudeStatusConfirmsLogin,
  startClaudeLogin,
} from "../src/claude-login.js";

function fakeChild() {
  const child = new EventEmitter() as ChildProcess;
  child.kill = vi.fn();
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  return child;
}

describe("claudeStatusConfirmsLogin", () => {
  it("requires a logged-in status", () => {
    expect(claudeStatusConfirmsLogin(0, '{"loggedIn":true}')).toBe(true);
    expect(claudeStatusConfirmsLogin(0, "Logged in as ada@example.com")).toBe(true);
    expect(claudeStatusConfirmsLogin(0, '{"loggedIn":false}')).toBe(false);
    expect(claudeStatusConfirmsLogin(0, "Not logged in")).toBe(false);
    expect(claudeStatusConfirmsLogin(1, '{"loggedIn":true}')).toBe(false);
  });
});

describe("startClaudeLogin", () => {
  it("spawns claude auth login and only succeeds after auth status confirms login", async () => {
    const login = fakeChild();
    const status = fakeChild();
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => login)
      .mockImplementationOnce(() => status) as unknown as ClaudeSpawn;
    const pending = startClaudeLogin({
      spawn,
      env: { HOME: "/Users/ada", PATH: "/usr/bin" },
      timeoutMs: 1000,
    });
    expect(spawn).toHaveBeenCalledWith(CLAUDE_LOGIN_COMMAND, CLAUDE_LOGIN_ARGS, {
      env: { HOME: "/Users/ada", PATH: "/usr/bin" },
      stdio: "ignore",
      windowsHide: true,
    });
    login.emit("exit", 0);
    expect(spawn).toHaveBeenCalledWith(CLAUDE_LOGIN_COMMAND, CLAUDE_STATUS_ARGS, {
      env: { HOME: "/Users/ada", PATH: "/usr/bin" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    status.stdout?.emit("data", '{"loggedIn":true}');
    status.emit("exit", 0);
    await expect(pending).resolves.toEqual({ ok: true });
  });

  it("does not confirm a login when status says the operator is signed out", async () => {
    const login = fakeChild();
    const status = fakeChild();
    const spawn = vi
      .fn()
      .mockImplementationOnce(() => login)
      .mockImplementationOnce(() => status) as unknown as ClaudeSpawn;
    const pending = startClaudeLogin({ spawn, env: {}, timeoutMs: 1000 });
    login.emit("exit", 0);
    status.stdout?.emit("data", '{"loggedIn":false}');
    status.emit("exit", 0);
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Claude is not signed in on this computer.",
    });
  });

  it("reports a missing CLI without returning output", async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child) as unknown as ClaudeSpawn;
    const pending = startClaudeLogin({ spawn, env: {}, timeoutMs: 1000 });
    child.emit("error", new Error("spawn claude ENOENT"));
    await expect(pending).resolves.toEqual({
      ok: false,
      error: "Claude Code is not installed on this computer.",
    });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
