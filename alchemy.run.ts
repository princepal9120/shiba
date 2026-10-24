/**
 * Alchemy v2 deploy definition — mirrors `apps/backend/wrangler.jsonc`
 * (the binding/source-of-truth contract). Edit wrangler first, then align
 * this file; CI runs `node scripts/check-alchemy-drift.mjs`.
 *
 * Primary deploy: `pnpm deploy:alchemy`. Rollback: `npx wrangler deploy
 * --config apps/backend/wrangler.jsonc` (see docs/DEPLOY.md).
 *
 * wrangler.jsonc -> props mapping:
 *   name                          -> Worker "shiba-ai-coworker" (live stages; see below)
 *   main                          -> main
 *   compatibility_date/_flags     -> compatibility.{date,flags}
 *   assets.{directory,not_found_handling} -> assets.{directory,notFoundHandling}
 *   preview_urls: false           -> workersDev.previewsEnabled: false
 *   vars                          -> env string entries
 *   ai.binding                    -> env AI: Cloudflare.Workers.AI()
 *   worker_loaders[].binding      -> env LOADER: Cloudflare.WorkerLoader(...)
 *   durable_objects.bindings      -> env entries (Cloudflare.DurableObject;
 *                                    Sandbox comes from its Container decl)
 *   containers[]                  -> env Sandbox: Cloudflare.Container(...)
 *   migrations new_sqlite_classes -> emitted automatically by the provider
 *                                    for DO classes new to the script
 *
 * Deploy-time secrets (the `wrangler secret put` set): `secrets(NAMES)`
 * binds each present `NAME` as `secret_text`; unset names are skipped,
 * matching optional env entries.
 * `Redacted.make` is used instead of Config helpers — it exists on effect 4,
 * satisfying both this repo and alchemy's declared peer.
 *
 * Worker + container names: pinned to the wrangler names on live stages so
 * the first deploy adopts the wrangler-managed resources in place; on any
 * non-live stage BOTH are suffixed, so `deploy --stage test-*` / `destroy`
 * can never collide with or clobber the live worker or container app — the
 * same isolation the wrangler ephemeral deploys got from a name override.
 * Names are static (not `Effect`s): an unresolved name makes the engine
 * skip the pre-deploy adopt-read, which would break live adoption. The
 * stage is therefore read from $ALCHEMY_STAGE at module level — do NOT
 * pass `--stage`; the stack effect asserts env/flag agreement and dies
 * with a clear error if they diverge.
 *
 * State backend: `Alchemy.localState()` (filesystem) by default — it works
 * with a plain CLOUDFLARE_API_TOKEN and no bootstrap step. Set
 * ALCHEMY_STATE_BACKEND=cloudflare to opt back into the remote State
 * Store after a one-time `npx alchemy provider cloudflare bootstrap`
 * (needs a token with the account Secrets Store scope).
 */
import { existsSync } from "node:fs";
import { Effect, Redacted } from "effect";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { CodingOrchestrator } from "./apps/backend/src/agents/orchestrator.js";
import type { OpenCodeAgent } from "./apps/backend/src/agents/opencode-agent.js";
import type { Mailbox } from "./apps/backend/src/mailbox-do.js";
import type { Memory } from "./apps/backend/src/memory-do.js";
import type { Sandbox } from "./apps/backend/src/sandbox.js";
import type { Waitlist } from "./apps/backend/src/waitlist-do.js";
import type { ModelConfig } from "./apps/backend/src/model-config-do.js";

// alchemy loads .env into its own config store, not process.env — which
// secrets()/configVars() read. Real env vars still win.
if (existsSync(".env")) process.loadEnvFile(".env");

const secrets = (names: readonly string[]) => {
  const entries: Record<string, ReturnType<typeof Redacted.make>> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) entries[name] = Redacted.make(value);
  }
  return entries;
};

// Deploy-time config that is NOT a secret (feature flags, model picks) —
// bound as plain vars like wrangler's vars[] block, only when exported.
const configVars = (names: readonly string[]) => {
  const entries: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value) entries[name] = value;
  }
  return entries;
};

const LIVE_STAGE = /^live(_|$)/;
const stage = process.env.ALCHEMY_STAGE;
const isLiveStage = stage === undefined || LIVE_STAGE.test(stage);
const workerName = isLiveStage ? "shiba-ai-coworker" : `shiba-ai-coworker-${stage}`;
const containerName = isLiveStage ? "shiba-ai-coworker-sandbox" : `shiba-ai-coworker-sandbox-${stage}`;
// Same stage isolation for the megaplan stores (KV/R2/D1/Vectorize): live
// stages pin the wrangler names, test stages get a suffixed copy. Vectorize
// names only allow lowercase letters, digits and hyphens — `_` stages
// (alchemy's own pattern allows them) are normalized to `-`.
const resSuffix = isLiveStage ? "" : `-${(stage as string).replaceAll("_", "-")}`;
// Stage segments must still form valid Worker names (lowercase, digits,
// dashes, start with a letter) — the CLI's own stage pattern allows `_`.
if (!/^[a-z][a-z0-9-]{0,62}$/.test(workerName) || !/^[a-z][a-z0-9-]{0,62}$/.test(containerName)) {
  throw new Error(`ALCHEMY_STAGE '${stage}' cannot form a valid Worker name`);
}

// Cloudflare Access: hostname apps, not the Worker `access` prop — Worker-level
// Access 403s WebSocket upgrades, and the dashboard runs on one.
const accessEmails = (process.env.ACCESS_EMAILS ?? "").split(",").map((e: string) => e.trim()).filter(Boolean);
const workersSubdomain = process.env.WORKERS_SUBDOMAIN?.trim();
const workerHost = workersSubdomain ? `${workerName}.${workersSubdomain}.workers.dev` : undefined;
const accessEnabled = isLiveStage && workerHost !== undefined && accessEmails.length > 0;
if (isLiveStage && !accessEnabled) {
  // No managed Access app: identity comes from the built-in email lane (BETTER_AUTH_SECRET);
  // with neither lane the Worker gate fails closed on its own.
  console.warn(
    "alchemy: live stage without DashboardAccess — dashboard sign-in uses BETTER_AUTH_SECRET; " +
      "set ACCESS_EMAILS and WORKERS_SUBDOMAIN to manage Access here.",
  );
}
// Machine callers authenticate inside the Worker (Slack/GitHub HMAC, MCP bearer,
// automation secret) and cannot complete an Access login.
export const ACCESS_BYPASS_PATHS = [
  "/api/slack/events",
  "/api/slack/command",
  "/api/slack/interact",
  "/api/telegram/webhook",
  "/api/discord/interactions",
  "/api/github/webhook",
  "/api/linear/webhook",
  // Sentry issue alerts authenticate in-Worker via the hook signature or
  // shared-secret token (sentry-webhook-routes.ts) and cannot complete an
  // Access login — same machine-caller class as the GitHub webhook.
  "/api/sentry/webhook",
  "/mcp",
  "/mcp/*",
  "/api/local/*",
  "/api/automations/*/trigger",
  "/api/waitlist",
  "/api/trigger",
];
const DashboardAccess = accessEnabled
  ? Cloudflare.Access.Application("DashboardAccess", {
      type: "self_hosted",
      name: workerName,
      destinations: [{ type: "public", uri: workerHost as string }],
      sessionDuration: "24h",
      policies: [{ name: "owners", decision: "allow", include: accessEmails.map((email: string) => ({ email })) }],
    })
  : undefined;
const MachineBypass = accessEnabled
  ? Cloudflare.Access.Application("MachineBypass", {
      type: "self_hosted",
      name: `${workerName}-machine-callers`,
      destinations: ACCESS_BYPASS_PATHS.map((path) => ({ type: "public" as const, uri: `${workerHost}${path}` })),
      policies: [{ name: "worker-authenticates", decision: "bypass", include: ["everyone"] }],
    })
  : undefined;

// Hoisted so the stack can print its id: scripts/mint-token.mjs writes tokens into it.
const AgentTokens = Cloudflare.KV.Namespace("AGENT_TOKENS", {
  title: `shiba-agent-tokens${resSuffix}`,
});

export const Worker = Cloudflare.Worker("Worker", {
  name: workerName,
  main: new URL("./apps/backend/src/index.ts", import.meta.url).href,
  compatibility: {
    date: "2026-06-01",
    // legacy_module_registry: alchemy otherwise adds new_module_registry; keep wrangler parity.
    flags: ["nodejs_compat", "legacy_module_registry"],
  },
  assets: {
    directory: "./app-public",
    notFoundHandling: "404-page",
  },
  // workers.dev disabled on live stages — app.tryshiba.dev is the only
  // public host (wrangler `workers_dev: false` parity; previews stay off).
  // Non-live (preview) stages enable workers.dev so `pr-<n>` deploys are
  // reachable at their own subdomain and never claim the live domain.
  workersDev: isLiveStage ? { enabled: false, previewsEnabled: false } : { enabled: true },
  // wrangler `routes` parity: app.tryshiba.dev is the single public
  // dashboard host (dashboard + /api same-origin). Custom domain
  // auto-manages DNS + edge TLS on the tryshiba.dev zone. Live stages only —
  // a preview stage claiming the zone route would steal prod traffic.
  ...(isLiveStage ? { domain: { name: "app.tryshiba.dev" } } : {}),
  crons: ["*/5 * * * *"],
  env: {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "@cf/zai-org/glm-4.7-flash",
    CODING_MODEL: "google/gemini-3.5-flash-lite",
    RUNTIME: "sandbox",
    SHIBA_CLAUDE_SUBSCRIPTION: "0",
    // Dark by default; configVars() below overrides from the deploy env.
    SHIBA_CODEX_SUBSCRIPTION: "0",
    SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH: "0",
    SHIBA_CODEX_DEVICE_AUTH: "0",
    SHIBA_CURSOR_SUBSCRIPTION: "0",
    SHIBA_ANTIGRAVITY_SUBSCRIPTION: "0",
    // Must match the Sandbox container's instanceType.
    INSTANCE_TYPE: "standard-1",
    // Public hostname for preview URLs + absolute screenshot links (T33).
    // Empty = PR screenshot capture disabled. Preview stages fall back to
    // their workers.dev hostname (or empty when WORKERS_SUBDOMAIN is unset).
    WORKER_HOSTNAME: isLiveStage ? "app.tryshiba.dev" : (workerHost ?? ""),
    BETTER_AUTH_URL: "https://app.tryshiba.dev",

    AI: Cloudflare.Workers.AI(),

    // Code Mode (`worker_loaders` in wrangler.jsonc) — dynamic isolate loader.
    LOADER: Cloudflare.WorkerLoader("LOADER"),

    // Workers Browser Rendering (T33) — wrangler `browser.binding`.
    BROWSER: Cloudflare.Browser("BROWSER"),

    CodingOrchestrator: Cloudflare.DurableObject<CodingOrchestrator>(
      "CodingOrchestrator",
      { className: "CodingOrchestrator" },
    ),
    OpenCodeAgent: Cloudflare.DurableObject<OpenCodeAgent>(
      "OpenCodeAgent",
      { className: "OpenCodeAgent" },
    ),
    Automations: Cloudflare.DurableObject("Automations", {
      className: "Automations",
    }),
    Mailbox: Cloudflare.DurableObject<Mailbox>("Mailbox", {
      className: "Mailbox",
    }),
    Memory: Cloudflare.DurableObject<Memory>("Memory", {
      className: "Memory",
    }),
    Waitlist: Cloudflare.DurableObject<Waitlist>("Waitlist", {
      className: "Waitlist",
    }),
    ModelConfig: Cloudflare.DurableObject<ModelConfig>("ModelConfig", {
      className: "ModelConfig",
    }),
    // T51: the local-runtime claim mailbox — one singleton DO serializes
    // dispatch/claim/settle between the Worker and the operator daemon.
    LocalDispatch: Cloudflare.DurableObject("LocalDispatch", {
      className: "LocalDispatch",
    }),
    ChatGptAuth: Cloudflare.DurableObject("ChatGptAuth", {
      className: "ChatGptAuth",
    }),
    UserProviderOAuth: Cloudflare.DurableObject("UserProviderOAuth", {
      className: "UserProviderOAuth",
    }),

    // Megaplan stores — wrangler keeps `__PENDING__` ids until the resources
    // are created; alchemy provisions them on first deploy.
    AGENT_TOKENS: AgentTokens,
    ATTACHMENTS: Cloudflare.R2.Bucket("ATTACHMENTS", {
      name: `shiba-attachments${resSuffix}`,
    }),
    AGENT_AUDIT: Cloudflare.D1.Database("AGENT_AUDIT", {
      name: `shiba-audit${resSuffix}`,
    }),
    MEMORY_VECTORS: Cloudflare.Vectorize.Index("MEMORY_VECTORS", {
      name: `shiba-memory${resSuffix}`,
      dimensions: 768,
      metric: "cosine",
    }),
    SEND_EMAIL: Cloudflare.Email.SendEmail("SEND_EMAIL"),

    // Pre-auth limit on /mcp — wrangler [[ratelimits]] MCP_RATE_LIMIT.
    MCP_RATE_LIMIT: Cloudflare.RateLimit("MCP_RATE_LIMIT", {
      namespaceId: "1001",
      simple: { limit: 100, period: 60 },
    }),

    // wrangler durable_objects.bindings Sandbox + containers[0]: the
    // Container decl is the DO namespace binding plus its container app.
    // SANDBOX_IMAGE swaps in a pre-pushed registry.cloudflare.com ref so
    // deploys work on machines without a local Docker daemon (the image is
    // built+ pushed by .github/workflows/build-sandbox-image.yml).
    Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
      name: containerName,
      ...(process.env.SANDBOX_IMAGE
        ? { image: process.env.SANDBOX_IMAGE }
        : { context: "./apps/backend", dockerfile: "./apps/backend/Dockerfile" }),
      instanceType: "standard-1",
      maxInstances: 10,
    }),

    ...secrets([
      "GITHUB_TOKEN",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_INSTALLATION_ID",
      "GITHUB_APP_REPO_INSTALLATIONS",
      "GITHUB_WEBHOOK_SECRET",
      "LINEAR_WEBHOOK_SECRET",
      "LINEAR_API_KEY",
      "LINEAR_OAUTH_ACCESS_TOKEN",
      "LINEAR_DEFAULT_REPO_URL",
      "SLACK_SIGNING_SECRET",
      "SLACK_APPROVERS",
      // Dashboard emails allowed to resolve shared ("default" DO) approvals:
      // automations, review lane, Sentry, email. Unset = nobody.
      "DASHBOARD_APPROVERS",
      "SLACK_BOT_TOKEN",
      "SLACK_CHANNEL_REPOS",
      "TYPESAFE_API_KEY",
      "AI_GATEWAY_TOKEN",
      // T48: the operator's `claude setup-token` output; per-account secrets
      // (CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT>) resolve by name at egress.
      "CLAUDE_SUBSCRIPTION_TOKEN",
      // T49: the operator's `codex login` auth.json contents; per-account
      // secrets (CODEX_SUBSCRIPTION_AUTH_JSON_<ACCOUNT>) resolve by name.
      "CODEX_SUBSCRIPTION_AUTH_JSON",
      // cursor-subscription: the operator's Cursor Agent API key; per-account
      // secrets (CURSOR_SUBSCRIPTION_TOKEN_<ACCOUNT>) resolve by name.
      "CURSOR_SUBSCRIPTION_TOKEN",
      "GOOGLE_ANTIGRAVITY_CLIENT_SECRET",
      // T51: the bearer the `shiba local` daemon presents on /api/local/*.
      "LOCAL_ADAPTER_TOKEN",
      // Built-in dashboard auth signing secret (better-auth.ts): absent =
      // the lane is dark and the gate falls back to Access/fail-closed.
      "BETTER_AUTH_SECRET",
      // First-account gate for public hosts. Either secret is enough.
      // Unset on a public URL refuses sign-up. Loopback dev does not need them.
      "BETTER_AUTH_BOOTSTRAP_TOKEN",
      "BETTER_AUTH_OWNER_EMAIL",
      "GMAIL_CLIENT_SECRET",
      "GMAIL_TOKEN_KEY",
      "MODEL_CREDENTIAL_KEY",
      // Telegram + Discord webhook lanes.
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_WEBHOOK_SECRET",
      "DISCORD_PUBLIC_KEY",
      // T52: HMAC key for dashboard-minted pairing tokens (optional —
      // falls back to LOCAL_ADAPTER_TOKEN when unset).
      "PAIRING_SECRET",
      // Edge vouched-header signing (optional; unset = header-trust fallback).
      "INTERNAL_SIGNING_KEY",
      // Automation trigger lane (`/api/trigger`).
      "TRIGGER_TOKEN",
    ]),
    // REQUIRE_ACCESS without ACCESS_AUD trusts a client-sent Access email header, so only pair them.
    ...(DashboardAccess
      ? { REQUIRE_ACCESS: "1", ACCESS_AUD: DashboardAccess.pipe(Effect.map((app) => app.aud)) }
      : {}),
    // T56 (PLAN.md §20): the shipped role pin, as a LITERAL env member — the
    // drift guard compares declared vars by value (scripts/check-alchemy-drift.mjs),
    // so a configVars() spread would read as an absent var. Model ids verified
    // against primary sources 2026-10-06; orchestrator moved to gpt-6-sol ahead
    // of gpt-5.6-sol's 2026-10-14 Codex retirement (PLAN.md §20.2). The
    // reviewer pin keeps #99's Sol review lane (opencode-go/gpt-6.1-sol).
    ROLE_MODEL_MAP:
      "{\"orchestrator\":{\"harness\":\"codex\",\"model\":\"openai/gpt-6-sol\"},\"explorer\":{\"harness\":\"codex\",\"model\":\"openai/gpt-6-sol\"},\"fixer\":{\"harness\":\"claude-code\",\"model\":\"anthropic/claude-sonnet-5-5\"},\"reviewer\":{\"harness\":\"opencode\",\"model\":\"opencode-go/gpt-6.1-sol\"},\"designer\":{\"harness\":\"claude-code\",\"model\":\"anthropic/claude-opus-5-5\"}}",
    ...configVars([
      "REQUIRE_ACCESS",
      "AUTOMATIONS_ENABLED",
      "AGENT_HARNESS",
      "CLAUDE_CODE_MODEL",
      // T48: dark by default — may violate Anthropic terms when enabled.
      "SHIBA_CLAUDE_SUBSCRIPTION",
      "SHIBA_SINGLE_USER",
      "CLAUDE_SUBSCRIPTION_MODEL",
      // T49 opt-ins (§18.11): absent = the subscription harness is dark.
      "SHIBA_CODEX_SUBSCRIPTION",
      "SHIBA_CHATGPT_SIWC_SANDBOX_OAUTH",
      "SHIBA_CODEX_DEVICE_AUTH",
      "CODEX_SUBSCRIPTION_MODEL",
      // T50 opt-ins (§18.12): absent = the antigravity flow is dark. No
      // credential var exists — OAuth tokens live in the container profile.
      "SHIBA_ANTIGRAVITY_SUBSCRIPTION",
      "ANTIGRAVITY_SUBSCRIPTION_MODEL",
      // cursor subscription lane: absent = the auth surface is dark.
      "SHIBA_CURSOR_SUBSCRIPTION",
      "CURSOR_SUBSCRIPTION_MODEL",
      // ACP registry lane (PLAN-V2-NEXT): the allowlist opens it;
      // ACP_REGISTRY_JSON pins the registry snapshot resolution runs on.
      "ACP_REGISTRY_ALLOWLIST",
      "ACP_REGISTRY_JSON",
      "ACP_MODEL",
      // T51 opt-in (§18.13): absent = the local runtime is dark.
      "SHIBA_LOCAL_RUNTIME",
      "CODEX_MODEL",
      "GROK_MODEL",
      "PI_MODEL",
      // T52: per-role routing pins (agents/roles.ts) — absent = roles
      // resolve through the deployment default chain.
      "ROLE_MODEL_MAP",
      "ROLE_MODEL__ORCHESTRATOR",
      "ROLE_MODEL__EXPLORER",
      "ROLE_MODEL__FIXER",
      "ROLE_MODEL__REVIEWER",
      "ROLE_MODEL__DESIGNER",
      "SLACK_APPROVALS_CHANNEL",
      // Agent mailbox identity (default dev@tryshiba.dev).
      "AGENT_MAILBOX",
      "MEMORY_ENABLED",
      "TELEGRAM_APPROVERS",
      "TELEGRAM_CHAT_REPOS",
      "TELEGRAM_AGENT_HARNESS",
      "DISCORD_APPROVERS",
      "DISCORD_CHANNEL_REPOS",
      "DISCORD_AGENT_HARNESS",
      "WORKER_HOSTNAME",
      // Built-in dashboard auth: canonical public URL for cookie scope and
      // origin checks; unset = each request's own origin.
      "BETTER_AUTH_URL",
      "GMAIL_CLIENT_ID",
      "GMAIL_REDIRECT_URI",
    ]),
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "shiba-ai-coworker",
  {
    providers: Cloudflare.providers(),
    state:
      process.env.ALCHEMY_STATE_BACKEND === "cloudflare"
        ? Cloudflare.state()
        : Alchemy.localState(),
  },
  // Live stages adopt the wrangler-managed resources in place (the same
  // resources are declared 1:1, so adoption is a takeover of our own
  // worker/bindings, not a foreign one). Test stages never adopt — their
  // stage-suffixed names create fresh resources instead.
  Effect.gen(function* () {
    // The resource names above are derived from $ALCHEMY_STAGE at module
    // load; a `--stage` flag that disagrees with it would deploy
    // unsuffixed names from a non-live stage (or vice versa). Fail loudly
    // instead of colliding with live.
    const resolvedStage = yield* Alchemy.Stage;
    const envStage = process.env.ALCHEMY_STAGE;
    if (
      resolvedStage !== envStage &&
      !(envStage === undefined && LIVE_STAGE.test(resolvedStage))
    ) {
      yield* Effect.die(
        new Error(
          `alchemy stage mismatch: engine resolved stage '${resolvedStage}' but $ALCHEMY_STAGE is '${envStage ?? "(unset)"}'. ` +
            `Select the stage via $ALCHEMY_STAGE only — resource names are derived from it, so a diverging --stage would bypass the suffix.`,
        ),
      );
    }
    const worker = yield* Worker;
    // Scoped memory recall filters on `agent`; Vectorize ignores unindexed metadata.
    yield* Cloudflare.Vectorize.MetadataIndex("MemoryAgentIndex", {
      indexName: `shiba-memory${resSuffix}`,
      propertyName: "agent",
      indexType: "string",
    });
    if (DashboardAccess && MachineBypass) {
      yield* DashboardAccess;
      yield* MachineBypass;
    } else if (isLiveStage) {
      yield* Effect.logWarning(
        "Cloudflare Access not managed here (set ACCESS_EMAILS and WORKERS_SUBDOMAIN): dashboard sign-in relies on BETTER_AUTH_SECRET.",
      );
    }
    const tokens = yield* AgentTokens;
    const base = workerHost ? `https://${workerHost}` : worker.url;
    return {
      url: base,
      mcp: workerHost ? `${base}/mcp` : undefined,
      slackEvents: workerHost ? `${base}/api/slack/events` : undefined,
      githubWebhook: workerHost ? `${base}/api/github/webhook` : undefined,
      agentTokensNamespace: tokens.namespaceId,
    };
  }).pipe(Alchemy.AdoptPolicy.adopt(isLiveStage)),
);
