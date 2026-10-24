import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";

/** Fixed argv. The renderer cannot choose the binary or the arguments. */
export const CLAUDE_LOGIN_COMMAND = "claude";
export const CLAUDE_LOGIN_ARGS = ["auth", "login"] as const;
export const CLAUDE_STATUS_ARGS = ["auth", "status"] as const;
export const CLAUDE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export type ClaudeStdio = "ignore" | ["ignore", "pipe", "pipe"];

export type ClaudeSpawn = (
  command: string,
  args: readonly string[],
  options: { env: NodeJS.ProcessEnv; stdio: ClaudeStdio; windowsHide: boolean },
) => ChildProcess;

export type ClaudeLoginResult = { ok: true } | { ok: false; error: string };

/**
 * `claude auth status` confirms a login. Exit 0 alone is not enough: the
 * stdout must say the operator is logged in. The text is not returned.
 */
export function claudeStatusConfirmsLogin(code: number | null, stdout: string): boolean {
  if (code !== 0) return false;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as { loggedIn?: unknown; logged_in?: unknown };
      if (typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
      if (typeof parsed.logged_in === "boolean") return parsed.logged_in;
    } catch {
      // Not JSON. Fall through to the text check.
    }
  }
  if (/not logged in/i.test(stdout)) return false;
  return /logged in/i.test(stdout);
}

/**
 * Runs `claude auth login`, then `claude auth status`. Pairing may start
 * only after status confirms a login. Login output is ignored so a token
 * printed by the CLI never reaches logs or the renderer.
 */
export function startClaudeLogin(deps: {
  spawn?: ClaudeSpawn;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<ClaudeLoginResult> {
  const spawn = deps.spawn ?? nodeSpawn;
  const timeoutMs = deps.timeoutMs ?? CLAUDE_LOGIN_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: ChildProcess | undefined;
    const finish = (result: ClaudeLoginResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const failSpawn = () => {
      finish({
        ok: false,
        error: "Claude Code could not be started. Install it, then try again.",
      });
    };
    const watch = (child: ChildProcess, onExit: (code: number | null) => void) => {
      active = child;
      child.once("error", () => {
        finish({ ok: false, error: "Claude Code is not installed on this computer." });
      });
      child.once("exit", (code) => onExit(code));
    };
    const runStatus = () => {
      let status: ChildProcess;
      try {
        status = spawn(CLAUDE_LOGIN_COMMAND, CLAUDE_STATUS_ARGS, {
          env: deps.env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        failSpawn();
        return;
      }
      let stdout = "";
      status.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
        if (stdout.length > 8_192) stdout = stdout.slice(0, 8_192);
      });
      watch(status, (code) => {
        if (claudeStatusConfirmsLogin(code, stdout)) finish({ ok: true });
        else finish({ ok: false, error: "Claude is not signed in on this computer." });
      });
    };
    let login: ChildProcess;
    try {
      login = spawn(CLAUDE_LOGIN_COMMAND, CLAUDE_LOGIN_ARGS, {
        env: deps.env,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      failSpawn();
      return;
    }
    timer = setTimeout(() => {
      active?.kill();
      finish({ ok: false, error: "Claude sign-in timed out." });
    }, timeoutMs);
    watch(login, (code) => {
      if (code !== 0) {
        finish({ ok: false, error: "Claude sign-in did not finish." });
        return;
      }
      runStatus();
    });
  });
}
