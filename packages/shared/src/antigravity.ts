/**
 * T50 — the Antigravity OAuth callback + profile layout, ported verbatim
 * from t3code's antigravityCallback.ts / antigravityAuthSupport.ts
 * (PLAN.md §18.12). "Most likely to be got wrong" — every check below is a
 * t3code check, loosened nowhere; loosening any of them lets a stranger's
 * `http://127.0.0.1/` URL deliver an arbitrary sign-in code into the
 * container's OAuth listener.
 *
 * Shiba adaptations (recorded in VERIFICATION.md):
 *   - The listener lives inside a Cloudflare Sandbox — `sandboxId` rides
 *     on the pending record so the Worker route can find the container.
 *   - Forwarding is a scoped `curl` exec inside that container (the
 *     listener binds container-loopback; exposePort cannot reach it).
 *     Same posture as t3code's node:http send: no proxies, no redirects,
 *     no response logging, 10 s timeout, 2xx required.
 */

/** t3code: prefix the ACP binary prints before the sign-in URL on stdout. */
export const ANTIGRAVITY_AUTH_STDOUT_PREFIX =
  "Open the following link to authenticate the ACP server: ";

/** t3code: both URL fields cap at 16_384 characters. */
export const ANTIGRAVITY_MAX_URL_LENGTH = 16_384;

/**
 * Ambient environment keys stripped before any ACP process is spawned —
 * verbatim from t3code's `removedEnvironmentKeys`. Compared
 * case-insensitively (Windows treats keys case-insensitively).
 */
export const ANTIGRAVITY_REMOVED_ENV_KEYS: readonly string[] = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_QUOTA_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CORE_PROJECT",
  "AGY_ACP_CCPA_PROJECT",
  "AGY_ACP_ENABLE_OAUTH",
  "GEMINI_HOME",
  "AGY_ACP_FORCE_FILE_STORAGE",
  "ANTIGRAVITY_HARNESS_PATH",
  "BROWSER",
  "PYTHONUNBUFFERED",
  "ELECTRON_RUN_AS_NODE",
];

/**
 * `node -e` snippet set as the profile's BROWSER command — the ACP opens
 * the sign-in page through it; it writes the URL and exits 0 (EPIPE must
 * still exit 0 or Python falls back to an OS browser). Source kept free
 * of colons and semicolons — verbatim from t3code.
 */
export const ANTIGRAVITY_BROWSER_HELPER_SOURCE =
  'process.stderr.on("error",()=>process.exit(0)).write("__SHIBA_ANTIGRAVITY_AUTH_URL__"+JSON.stringify(process.argv[1])+"\\n",()=>process.exit(0))';

export class AntigravityCallbackError extends Error {
  readonly code = "antigravity_callback";
  constructor(message: string) {
    super(message);
    this.name = "AntigravityCallbackError";
  }
}

/**
 * The pending-callback payload stored on the T47 flow record while
 * `waiting` — the single expected `state` + the listener's redirect_uri
 * + which sandbox holds the process.
 */
export interface AntigravityPendingCallback {
  readonly redirectUri: string;
  readonly state: string;
  readonly sandboxId: string;
}

export interface AntigravityAuthorizationUrl {
  readonly authorizationUrl: string;
  readonly redirectUri: string;
  readonly state: string;
}

/**
 * Per-account profile root inside the sandbox (`/root` is container HOME).
 * Pure path math — shared so `src/auth/` resolves it without importing
 * `harness/` (the dependency rule).
 */
export function antigravitySubscriptionProfileDir(input: { authAccount?: string }): string {
  const account = (input.authAccount ?? "default").toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return `/root/.shiba/antigravity/${account}`;
}

/**
 * The BROWSER command t3code installs: `node -e <helper> -- %s` — the ACP
 * opens the sign-in page through it; the helper prints the URL and exits.
 */
export function antigravityBrowserCommand(nodeExecutable = "node"): string {
  return `${nodeExecutable} -e ${ANTIGRAVITY_BROWSER_HELPER_SOURCE} -- %s`;
}

/**
 * Validate the authorization URL the ACP printed — verbatim port of
 * t3code `parseAntigravityAuthorizationUrl`:
 *   accounts.google.com/o/oauth2/v2/auth, exactly one state (non-empty,
 *   ≤512, no whitespace), exactly one response_type=code, exactly one
 *   redirect_uri matching http://127.0.0.1:<1024+>/ .
 */
export function parseAntigravityAuthorizationUrl(
  authorizationUrl: string,
): AntigravityAuthorizationUrl {
  const invalid = () =>
    new AntigravityCallbackError("Antigravity returned an invalid Google sign-in URL.");
  if (authorizationUrl.length > ANTIGRAVITY_MAX_URL_LENGTH || /\s/.test(authorizationUrl)) {
    throw invalid();
  }
  let url: URL;
  try {
    url = new URL(authorizationUrl);
  } catch {
    throw invalid();
  }
  const state = url.searchParams.get("state");
  const redirectUri = url.searchParams.get("redirect_uri");
  if (
    url.origin !== "https://accounts.google.com" ||
    url.pathname !== "/o/oauth2/v2/auth" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.searchParams.getAll("state").length !== 1 ||
    url.searchParams.getAll("redirect_uri").length !== 1 ||
    url.searchParams.getAll("response_type").length !== 1 ||
    url.searchParams.get("response_type") !== "code" ||
    state === null ||
    state.length === 0 ||
    state.length > 512 ||
    /\s/.test(state) ||
    redirectUri === null ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/$/.test(redirectUri)
  ) {
    throw invalid();
  }
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw invalid();
  }
  if (Number(redirect.port) < 1024) throw invalid();
  return { authorizationUrl, redirectUri, state };
}

/**
 * Validate the operator's pasted redirect URL against the pending record —
 * verbatim port of t3code `validateAntigravityCallbackUrl`:
 *   http://127.0.0.1 only, same origin+pathname as the listener's
 *   redirect_uri, no username/password/hash, exactly one `state` equal to
 *   the pending state, exactly one of code XOR error (non-empty), at most
 *   one `iss` and it must be https://accounts.google.com.
 * Returns the parsed callback on success; throws otherwise.
 */
export function validateAntigravityCallbackUrl(
  pending: AntigravityPendingCallback,
  callbackUrl: string,
): URL {
  if (callbackUrl.length > ANTIGRAVITY_MAX_URL_LENGTH) {
    throw new AntigravityCallbackError("The sign-in response URL is too long.");
  }
  let callback: URL;
  try {
    callback = new URL(callbackUrl);
  } catch {
    throw new AntigravityCallbackError(
      "Paste the complete redirect URL from the Google sign-in page.",
    );
  }
  const expected = new URL(pending.redirectUri);
  const notOurs = "This redirect URL does not belong to the current sign-in.";
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw new AntigravityCallbackError(notOurs);
  }
  const states = callback.searchParams.getAll("state");
  if (states.length !== 1 || states[0] !== pending.state) {
    throw new AntigravityCallbackError(notOurs);
  }
  const codes = callback.searchParams.getAll("code");
  const errors = callback.searchParams.getAll("error");
  if (
    !(
      (codes.length === 1 && Boolean(codes[0]) && errors.length === 0) ||
      (errors.length === 1 && Boolean(errors[0]) && codes.length === 0)
    )
  ) {
    throw new AntigravityCallbackError(
      "The redirect URL must contain one Google sign-in response.",
    );
  }
  const issuers = callback.searchParams.getAll("iss");
  if (
    issuers.length > 1 ||
    (issuers.length === 1 && issuers[0] !== "https://accounts.google.com")
  ) {
    throw new AntigravityCallbackError("The redirect URL is not a Google sign-in response.");
  }
  return callback;
}

/** Profile layout under a per-account root — t3code's AntigravityProfile. */
export interface AntigravityProfilePaths {
  readonly geminiHome: string;
  readonly acpDirectory: string;
  readonly tokenPath: string;
  readonly tempDirectory: string;
  readonly settingsPath: string;
}

/** `<geminiHome>/antigravity-acp/{acp_token.json,settings.json,tmp}` — verbatim. */
export function antigravityProfilePaths(profileDirectory: string): AntigravityProfilePaths {
  const geminiHome = profileDirectory;
  const acpDirectory = `${geminiHome}/antigravity-acp`;
  return {
    geminiHome,
    acpDirectory,
    tokenPath: `${acpDirectory}/acp_token.json`,
    tempDirectory: `${acpDirectory}/tmp`,
    settingsPath: `${acpDirectory}/settings.json`,
  };
}

/**
 * `settings.json` for the subscription profile — `auth.type` names the
 * method so a native sign-out clears only its credentials. Never holds a
 * credential (t3code `antigravityProfileSettings`, personal method only).
 */
export function antigravityProfileSettings(): string {
  return `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`;
}

/**
 * Environment for every ACP process — verbatim t3code `antigravityEnvironment`:
 * ambient credential keys stripped (uppercase compare), GEMINI_HOME points
 * at the profile, file-based credential storage forced (never the OS
 * keychain), browser launches routed to the suppressing helper, PyInstaller
 * temp pointed inside the profile.
 */
export function antigravityEnvironment(
  profile: AntigravityProfilePaths,
  baseEnv: Readonly<Record<string, string>>,
  browserCommand: string,
): Record<string, string> {
  const removed = new Set(ANTIGRAVITY_REMOVED_ENV_KEYS);
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!removed.has(key.toUpperCase())) environment[key] = value;
  }
  return {
    ...environment,
    GEMINI_HOME: profile.geminiHome,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    BROWSER: browserCommand,
    PYTHONUNBUFFERED: "1",
    ELECTRON_RUN_AS_NODE: "1",
    TMPDIR: profile.tempDirectory,
  };
}
