/**
 * T68: per-run environment variables. Records carry names + a keyed digest;
 * the values themselves only ever travel sealed (see apps/backend/src/run-env-seal.ts).
 */
export const RUN_ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_RUN_ENV_VARS = 32;
export const MAX_RUN_ENV_VALUE_CHARS = 8192;
export const MAX_RUN_ENV_TOTAL_CHARS = 32 * 1024;

export interface RunEnvVar {
  name: string;
  value: string;
}

// Names that steer the harness, egress, TLS trust, the loader or a toolchain's code/registry lookup.
// ponytail: denylist, not allowlist — app vars like NODE_ENV or DATABASE_URL must stay usable.
const RESERVED_NAMES = new Set([
  "PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "ENV", "BASH_ENV", "PROMPT_COMMAND",
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "NODE_TLS_REJECT_UNAUTHORIZED",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "MAVEN_OPTS", "GRADLE_OPTS", "RUSTC_WRAPPER", "RUSTFLAGS",
  "GOPROXY", "GOFLAGS", "GOPRIVATE", "GONOPROXY", "GONOSUMDB", "GOSUMDB", "GOPATH",
  "PERL5LIB", "PERL5OPT", "RUBYOPT", "RUBYLIB", "NODE_PATH", "EDITOR", "VISUAL",
]);
const RESERVED_PREFIXES = [
  "SHIBA_", "LD_", "DYLD_", "GIT_", "GITHUB_", "GH_", "CLOUDFLARE_", "CF_", "XDG_",
  "PYTHON", "NPM_CONFIG_", "PIP_", "UV_", "YARN_", "BUN_", "BUNDLE_", "CARGO_",
  "OPENCODE_", "CLAUDE_", "ANTHROPIC_", "OPENAI_", "CODEX_", "GOOGLE_", "GEMINI_",
  "XAI_", "GROK_", "DEVIN_", "CURSOR_", "PI_",
];

export function isReservedRunEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return RESERVED_NAMES.has(upper) || upper.endsWith("_PROXY") || RESERVED_PREFIXES.some((p) => upper.startsWith(p));
}

/** Validate and sort by name. Errors name the variable, never echo its value. */
export function parseRunEnv(raw: unknown): RunEnvVar[] {
  if (!Array.isArray(raw)) throw new Error("environmentVariables must be an array of { name, value }.");
  if (raw.length > MAX_RUN_ENV_VARS) throw new Error(`At most ${MAX_RUN_ENV_VARS} environment variables per run.`);
  const seen = new Set<string>();
  let total = 0;
  const vars = raw.map((entry) => {
    const { name, value } = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    if (typeof name !== "string" || !RUN_ENV_NAME.test(name)) {
      throw new Error(`Invalid environment variable name ${JSON.stringify(String(name).slice(0, 64))}.`);
    }
    if (isReservedRunEnvName(name)) throw new Error(`Environment variable ${name} is reserved by the harness or sandbox.`);
    if (seen.has(name)) throw new Error(`Environment variable ${name} is set twice.`);
    seen.add(name);
    if (typeof value !== "string" || value.length > MAX_RUN_ENV_VALUE_CHARS) {
      throw new Error(`Environment variable ${name} needs a string value of at most ${MAX_RUN_ENV_VALUE_CHARS} characters.`);
    }
    total += name.length + value.length;
    return { name, value };
  });
  if (total > MAX_RUN_ENV_TOTAL_CHARS) {
    throw new Error(`Environment variables total more than ${MAX_RUN_ENV_TOTAL_CHARS} characters.`);
  }
  return vars.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
