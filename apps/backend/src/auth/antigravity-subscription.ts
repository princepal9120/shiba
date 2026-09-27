/**
 * T50 — antigravity-subscription provider on the T47 core
 * (PLAN.md §18.12). The one flow that uses the `waiting` phase:
 *
 *   begin()     → spawn the pinned `agy` ACP binary in a dedicated auth
 *                 sandbox with the isolated profile env; it prints the
 *                 Google sign-in URL on stdout and listens on a
 *                 container-loopback port. Flow records
 *                 pending{redirectUri,state,sandboxId} and `waiting`.
 *   callback    → POST /api/antigravity/callback validates the operator's
 *                 pasted redirect URL against that pending record
 *                 (ruleset ported verbatim from t3code) and delivers it
 *                 into the container listener. Delivery ≠ authentication.
 *   verify()    → the capability probe — the ACP process exchanged the
 *                 code only if the profile's acp_token.json materialized.
 *
 * No credential ever lives in the Worker: tokens are written by the ACP
 * process into the container profile (AGY_ACP_FORCE_FILE_STORAGE=1), so
 * there is no Worker secret for this provider at all.
 */
import { getSandbox } from "@cloudflare/sandbox";
import {
  type AntigravityPendingCallback,
  type ProviderAuthController,
  antigravityBrowserCommand,
  antigravityEnvironment,
  antigravityProfilePaths,
  antigravityProfileSettings,
  antigravitySubscriptionProfileDir,
  parseAntigravityAuthorizationUrl,
  validateAntigravityCallbackUrl,
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
} from "@shiba/shared";
import { shellJoin } from "../security.js";
import { createAuthController, type AuthProviderHooks } from "./controller.js";

/** Minimal sandbox surface the flow needs — injected for tests. */
export interface AntigravityAuthSandbox {
  exec(command: string, opts?: { cwd?: string; env?: Record<string, string> }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
  }>;
  writeFile(path: string, content: string): Promise<void>;
  destroy?(): Promise<void>;
}

export interface AntigravityAuthDeps {
  sandboxFor(sandboxId: string): AntigravityAuthSandbox;
  /** Log-poll attempts before the auth URL is declared missing. Default 30. */
  pollAttempts?: number;
  /** Ms between polls. Default 1_000. */
  pollIntervalMs?: number;
}

/** Env the provider reads — the token KV and the sandbox binding. */
export interface AntigravityAuthEnv {
  AGENT_TOKENS: KVNamespace;
  // The DO binding's generic is Env-shaped; the provider only hands it to
  // getSandbox, so `unknown` keeps every Env assignable. Optional on the
  // type so the registry can refuse the harness before it is needed.
  Sandbox?: unknown;
}

const AUTH_SANDBOX_PREFIX = "agy-auth-";
const AUTH_LOG_PATH = "/tmp/agy-auth.log";

function sandboxIdFor(instanceId: string): string {
  return `${AUTH_SANDBOX_PREFIX}${instanceId.slice("agy-sub:".length)}`;
}

/**
 * Spawn `agy` detached inside the auth sandbox, env = the profile launch
 * env (ambient Google keys stripped by antigravityEnvironment), stdout
 * teed to AUTH_LOG_PATH for polling.
 */
async function spawnAuthProcess(
  sandbox: AntigravityAuthSandbox,
  profileDir: string,
): Promise<void> {
  const paths = antigravityProfilePaths(profileDir);
  const mkdir = await sandbox.exec(
    shellJoin(["mkdir", "-p", paths.acpDirectory, paths.tempDirectory]),
  );
  if (mkdir.exitCode !== 0) {
    throw new Error(`profile setup failed: ${mkdir.stderr.trim() || `exit ${mkdir.exitCode}`}`);
  }
  const chmod = await sandbox.exec(shellJoin(["chmod", "700", paths.geminiHome, paths.acpDirectory]));
  if (chmod.exitCode !== 0) {
    throw new Error(`profile setup failed: ${chmod.stderr.trim() || `exit ${chmod.exitCode}`}`);
  }
  await sandbox.writeFile(paths.settingsPath, antigravityProfileSettings());
  const env = antigravityEnvironment(paths, {}, antigravityBrowserCommand());
  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  // Detached: the process keeps listening on its loopback port after exec
  // returns; stdout carries the sign-in URL once it is ready.
  const spawn = await sandbox.exec(
    `${assignments} nohup agy --uid= > ${AUTH_LOG_PATH} 2>&1 </dev/null & echo started`,
  );
  if (spawn.exitCode !== 0 || !spawn.stdout.includes("started")) {
    throw new Error("the Antigravity sign-in process failed to start.");
  }
}

/** Poll the process log until the ACP prints its sign-in URL line. */
async function readAuthorizationUrl(
  sandbox: AntigravityAuthSandbox,
  deps: Pick<AntigravityAuthDeps, "pollAttempts" | "pollIntervalMs">,
): Promise<string> {
  const attempts = deps.pollAttempts ?? 30;
  const interval = deps.pollIntervalMs ?? 1_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const log = await sandbox.exec(shellJoin(["cat", AUTH_LOG_PATH])).catch(() => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    }));
    const line = log.stdout
      .split("\n")
      .find((entry) => entry.startsWith(ANTIGRAVITY_AUTH_STDOUT_PREFIX));
    if (line !== undefined) {
      return line.slice(ANTIGRAVITY_AUTH_STDOUT_PREFIX.length).trim();
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
  throw new Error("the Antigravity sign-in process did not offer a sign-in URL.");
}

/**
 * Deliver the validated callback into the container listener via scoped
 * exec curl — the faithful loopback send: --noproxy (no proxies), no
 * redirect following (curl default), -o /dev/null (no response logging),
 * --max-time 10 (10 s timeout), 2xx required.
 */
async function forwardIntoContainer(
  sandbox: AntigravityAuthSandbox,
  callback: URL,
): Promise<void> {
  const url = `http://127.0.0.1:${callback.port}${callback.pathname}${callback.search}`;
  const result = await sandbox.exec(
    shellJoin([
      "curl", "--noproxy", "*", "--max-time", "10", "-s", "-o", "/dev/null",
      "-w", "%{http_code}", "--request", "GET", url,
    ]),
  );
  const status = Number(result.stdout.trim());
  if (result.exitCode !== 0 || !(status >= 200 && status < 300)) {
    throw new Error("Could not deliver the sign-in response. Start sign-in again.");
  }
}

/**
 * Build the T47 controller for `agy-sub:<account>`. `deps` is the test
 * seam — production callers omit it and the sandbox comes from the
 * worker env binding.
 */
export function antigravitySubscriptionAuth(
  env: AntigravityAuthEnv,
  instanceId: string,
  deps?: AntigravityAuthDeps,
): ProviderAuthController {
  const sandboxFor =
    deps?.sandboxFor ??
    ((sandboxId: string) =>
      getSandbox(env.Sandbox as never, sandboxId) as unknown as AntigravityAuthSandbox);
  const account = instanceId.slice("agy-sub:".length);
  const profileDir = antigravitySubscriptionProfileDir({ authAccount: account });
  const hooks: AuthProviderHooks<AntigravityAuthEnv> = {
    async probe(_probeEnv, probeInstanceId) {
      const sandbox = sandboxFor(sandboxIdFor(probeInstanceId));
      const check = await sandbox.exec(
        shellJoin(["test", "-s", antigravityProfilePaths(profileDir).tokenPath]),
      );
      // Delivered callback is not proof — the ACP process writes the token
      // file only after a real exchange with Google.
      return check.exitCode === 0
        ? { ok: true, message: "Antigravity sign-in token is stored in the container profile." }
        : { ok: false, message: "the sign-in token is not in the container profile yet." };
    },
    async onBegin(_beginEnv, beginInstanceId) {
      const sandboxId = sandboxIdFor(beginInstanceId);
      const sandbox = sandboxFor(sandboxId);
      await spawnAuthProcess(sandbox, profileDir);
      const url = await readAuthorizationUrl(sandbox, deps ?? {});
      const { authorizationUrl, redirectUri, state } = parseAntigravityAuthorizationUrl(url);
      const pending: AntigravityPendingCallback = { redirectUri, state, sandboxId };
      return {
        wait: "Open the sign-in URL, complete Google sign-in, then paste the failed http://127.0.0.1 redirect URL back here.",
        authorizationUrl,
        pending,
      };
    },
    async deliverCallback(_env, _instanceId, pending, callbackUrl) {
      const record = pending as AntigravityPendingCallback;
      const callback = validateAntigravityCallbackUrl(record, callbackUrl);
      await forwardIntoContainer(sandboxFor(record.sandboxId), callback);
      return { message: "Sign-in response delivered — run verify to finish." };
    },
    async stopInFlight(_env, stopInstanceId) {
      // Best effort: stop the auth process in the dedicated auth sandbox.
      await sandboxFor(sandboxIdFor(stopInstanceId))
        .exec("pkill -f 'agy' || true")
        .catch(() => undefined);
    },
    async onCleared(_env, clearInstanceId) {
      await sandboxFor(sandboxIdFor(clearInstanceId)).destroy?.().catch(() => undefined);
    },
  };
  return createAuthController(env, instanceId, hooks);
}
