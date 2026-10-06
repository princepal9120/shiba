/**
 * Worker environment. Non-secret settings are plain vars from
 * wrangler.jsonc; credentials are Wrangler secrets and never leave
 * Worker code.
 */
import type { OpenCodeAgent } from "./agents/opencode-agent.js";
import type { CodingOrchestrator } from "./agents/orchestrator.js";
import type { Sandbox } from "./sandbox.js";

export interface Env {
  AI: Ai;
  /**
   * Dynamic Worker Loader for Code Mode (`worker_loaders` in wrangler.jsonc)
   * — the isolate sandbox `run_code` executes generated JavaScript in.
   * Optional so local/typecheck without the binding degrades to no tool.
   */
  LOADER?: WorkerLoader;
  CodingOrchestrator: DurableObjectNamespace<CodingOrchestrator>;
  OpenCodeAgent: DurableObjectNamespace<OpenCodeAgent>;
  Sandbox: DurableObjectNamespace<Sandbox>;
  /** Bound to the Automations Durable Object class in wrangler.jsonc. */
  Automations: DurableObjectNamespace;
  /**
   * Bound to the Mailbox Durable Object class in wrangler.jsonc — one stub
   * per mailbox address, plus the shared `__directory__` registry stub.
   */
  Mailbox: DurableObjectNamespace;
  /**
   * Bound to the Memory Durable Object class in wrangler.jsonc — one stub
   * per agent name plus the shared "global" registry that indexes fact ids
   * across agents (megaplan T8, see `memory-do.ts`).
   */
  Memory: DurableObjectNamespace;
  /**
   * T51: the LocalDispatch mailbox DO — the single serialized claim point
   * between a local runtime dispatch and the operator daemon that runs it.
   * Optional so a deployment without the local runtime (or a test env
   * without the binding) never resolves a stub it cannot serve.
   */
  LocalDispatch?: DurableObjectNamespace;
  /** Deployment-wide model connection catalog and purpose policy. */
  ModelConfig: DurableObjectNamespace;
  /** Private launch/contributor registrations. */
  Waitlist: DurableObjectNamespace;
  /**
   * Vectorize index holding the 768-dim bge-base embedding for every banked
   * fact, keyed by fact id (megaplan T8). Index name `shiba-memory`; the
   * index itself is provisioned outside code
   * (`wrangler vectorize create shiba-memory --dimensions=768 --metric=cosine`,
   * then `wrangler vectorize create-metadata-index shiba-memory
   * --property-name=agent --type=string` so `?agent=` recall filters work).
   */
  MEMORY_VECTORS: VectorizeIndex;
  /**
   * R2 bucket holding every inbound attachment body (keyed `emailId/partId`)
   * plus raw-source dumps of unparseable mail (`emailId/raw-source`). The
   * `email_attachments` manifest records which keys exist. Bucket name:
   * `shiba-attachments`; the bucket itself is provisioned outside code
   * (`wrangler r2 bucket create`).
   */
  ATTACHMENTS: R2Bucket;
  /**
   * KV namespace of agent bearer-token records keyed `tok_<sha256(raw)>` —
   * the raw token is never stored (megaplan T4, see `agent-tokens.ts`).
   * Namespace id is a wrangler.jsonc placeholder until
   * `wrangler kv namespace create AGENT_TOKENS` runs.
   */
  AGENT_TOKENS: KVNamespace;
  /**
   * D1 audit log for MCP tool calls — one row per call with a hashed args
   * fingerprint, never the args (megaplan T4, see `audit.ts`). Placeholder
   * database_id until `wrangler d1 create shiba-audit` runs.
   */
  AGENT_AUDIT: D1Database;
  /**
   * Optional. Pre-auth rate limit on `/mcp` (wrangler `ratelimits` binding):
   * `verifyToken` costs a KV read per request, so an unauthenticated flood
   * would be a quota-exhaustion vector. Keyed on `cf-connecting-ip`.
   */
  MCP_RATE_LIMIT?: RateLimit;
  /**
   * Optional. Workers Browser Rendering endpoint (wrangler `browser` binding,
   * megaplan T33). `puppeteer.launch()` accepts the Fetcher shape directly;
   * typed as Fetcher so tests can stub it without @cloudflare/puppeteer types.
   * Absent = preview screenshot capture disabled (fail-safe, never fails a run).
   */
  BROWSER?: Fetcher;
  /**
   * Optional. Outbound email sender the approval-gated `email_send`
   * executor uses (megaplan T7, `send_email` binding in wrangler.jsonc).
   * Requires Email Routing's Email Sending enabled on the account; the
   * email approval bridge reports unready while it is unset so queued
   * sends cannot strand behind an approval nothing can execute.
   */
  SEND_EMAIL?: SendEmail;
  ASSETS: Fetcher;
  /** AI Gateway id. Default "default". */
  GATEWAY_ID: string;
  /** Model id for the parent planning agent (Workers AI id). */
  ORCHESTRATOR_MODEL: string;
  /** Coding model in provider/model format, e.g. google/gemini-3.5-flash-lite. */
  CODING_MODEL: string;
  /** Optional default model for the claude-code harness, e.g. anthropic/claude-sonnet-4-6. */
  CLAUDE_CODE_MODEL?: string;
  /** Optional default model for the codex harness, e.g. openai/gpt-5.3-codex. */
  CODEX_MODEL?: string;
  /** Optional default model for the devin harness, e.g. devin/swe-2. */
  DEVIN_MODEL?: string;
  /** Optional default model for the grok harness, e.g. xai/grok-4.6. */
  GROK_MODEL?: string;
  /**
   * Optional per-role routing pins (T52, `agents/roles.ts`). A delegation
   * carrying `role` resolves harness+model from `ROLE_MODEL_MAP` (one JSON
   * object, e.g. {"fixer":{"harness":"opencode","model":"opencode-go/deepseek-v3.2"}}),
   * then the role's `ROLE_MODEL__<ROLE>` var ("harness/model" or bare
   * "harness"), then the deployment defaults. All optional; all read at
   * intake — a bad pin fails the request before an approval is minted.
   */
  ROLE_MODEL_MAP?: string;
  ROLE_MODEL__ORCHESTRATOR?: string;
  ROLE_MODEL__EXPLORER?: string;
  ROLE_MODEL__FIXER?: string;
  ROLE_MODEL__REVIEWER?: string;
  ROLE_MODEL__DESIGNER?: string;
  /** Optional kill switch. "false"/"0"/"off" stops every automation firing. */
  AUTOMATIONS_ENABLED?: string;
  /**
   * Optional kill switch for run-end session distillation into long-term
   * memory (megaplan T10, see `session-distill.ts`). Unset means enabled;
   * "false"/"0"/"off" disables the Memory DO writes — never the run.
   */
  MEMORY_ENABLED?: string;
  /** Agent harness: "opencode" (default), "claude-code", or "codex". */
  AGENT_HARNESS?: string;
  /** Per-lane harness overrides; fall back to AGENT_HARNESS when unset. */
  TELEGRAM_AGENT_HARNESS?: string;
  DISCORD_AGENT_HARNESS?: string;
  /** Optional. Harness for Slack-originated runs; defaults to AGENT_HARNESS, then "claude-code". */
  SLACK_AGENT_HARNESS?: string;
  /** "sandbox" (default), "computer" (preview-only refusal), or "local". */
  RUNTIME?: string;
  /**
   * T51 opt-in flag (§18.13): "1" admits `runtime: "local"` at intake and
   * opens the /api/local daemon surface. Off by default — absent, every
   * local-runtime request refuses 403 before any approval exists.
   */
  SHIBA_LOCAL_RUNTIME?: string;
  /**
   * T51 daemon credential: the bearer the operator's `shiba local` daemon
   * presents on /api/local/claim and /api/local/result. Unset = the
   * surface refuses every request even when the flag is on.
   */
  LOCAL_ADAPTER_TOKEN?: string;
  /** T52 HMAC key for dashboard-minted pairing tokens; falls back to LOCAL_ADAPTER_TOKEN. */
  PAIRING_SECRET?: string;
  /**
   * Deploy-time container size. Must match wrangler `containers.instance_type`.
   * lite | basic | standard-1 | standard-2 | standard-3 | standard-4.
   */
  INSTANCE_TYPE?: string;
  /**
   * Optional. This Worker's public hostname (no scheme), used by T33 to mint
   * sandbox preview URLs (`sandbox.exposePort`) and to form the absolute
   * screenshot link embedded in published PRs. Empty/unset = capture skipped.
   */
  WORKER_HOSTNAME?: string;
  /**
   * Optional. The agent's mailbox identity — the address `latest_verification`
   * scans when no `mailbox` arg is given, so a run agent can read OTP codes
   * and magic sign-in links during third-party logins. Default
   * `dev@tryshiba.dev`; the address must still be registered in the Inbox
   * and assigned to the calling principal like every other mailbox.
   */
  AGENT_MAILBOX?: string;
  /** Optional. Verifies Slack callbacks; unset disables all Slack routes. */
  SLACK_SIGNING_SECRET?: string;
  /** Optional. Comma-separated Slack user ids allowed to approve; unset = nobody. */
  SLACK_APPROVERS?: string;
  /** Optional. Bot token used only to post approval cards (chat.postMessage). */
  SLACK_BOT_TOKEN?: string;
  /**
   * Optional. Channel id email-kind approval cards post to. Run approvals
   * mint inside a Slack thread and post their card there; email approvals
   * mint with no thread context, so their cards need a configured channel.
   * Unset = the dashboard Approvals surface is their only resolve path.
   */
  SLACK_APPROVALS_CHANNEL?: string;
  /** Optional. Daily USD budget for the /api/usage report's budget line. */
  USAGE_BUDGET_USD?: string;
  /** Optional. JSON map `{channelId: "https://github.com/owner/repo"}` for bare mentions. */
  SLACK_CHANNEL_REPOS?: string;
  /** Optional. Telegram bot token from BotFather; unset disables the Telegram route. */
  TELEGRAM_BOT_TOKEN?: string;
  /** Optional. setWebhook secret_token, checked on the X-Telegram-Bot-Api-Secret-Token header only. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Optional. Comma-separated Telegram numeric user ids allowed to approve; unset = nobody. */
  TELEGRAM_APPROVERS?: string;
  /** Optional. JSON map `{chatId: "https://github.com/owner/repo"}` for commands without a URL. */
  TELEGRAM_CHAT_REPOS?: string;
  /** Optional. Discord application public key (hex); verifies interactions, unset disables the route. */
  DISCORD_PUBLIC_KEY?: string;
  /** Optional. Discord bot token, used only to post run progress back into the channel. */
  DISCORD_BOT_TOKEN?: string;
  /** Optional. Comma-separated Discord user ids allowed to approve; unset = nobody. */
  DISCORD_APPROVERS?: string;
  /** Optional. JSON map `{channelId: "https://github.com/owner/repo"}` for commands without a repo. */
  DISCORD_CHANNEL_REPOS?: string;
  /** Optional. TypeSafe System One key for `run_when`; unset falls back to Workers AI. */
  TYPESAFE_API_KEY?: string;
  /** Optional. Required only to open pull requests. Never sent to containers. */
  GITHUB_TOKEN?: string;
  /** Optional PAT with `project` scope for Projects v2 board sync (github-project.ts). */
  GITHUB_PROJECT_TOKEN?: string;
  /** Projects v2 board number on the repo owner; PRs land here when both are set. */
  GITHUB_PROJECT_NUMBER?: string;
  /** Optional. Server-side credential for AI Gateway. Never sent to containers. */
  AI_GATEWAY_TOKEN?: string;
  /**
   * Optional. HMAC key for edge identity signing (edge-identity.ts): the
   * Worker signs requests that carry vouched headers (X-Agent-Principal,
   * X-Shiba-Intake) into DO stubs, and DO consumers verify the signature
   * before trusting those headers. Unset keeps the pre-signing header-trust
   * behavior (with a once-per-lifetime warning) so local dev keeps working.
   * One secret shared by every DO type — set the same value on all stages
   * that should sign/verify each other.
   */
  INTERNAL_SIGNING_KEY?: string;
  /**
   * T48 opt-in flag (§18.10): "1" registers the claude-subscription harness.
   * Absent it is unregistered, uncataloged, and unselectable — the
   * subscription path is dark unless the deployment owner enables it.
   */
  SHIBA_CLAUDE_SUBSCRIPTION?: string;
  /**
   * T48 credential: the operator's `claude setup-token` output, stored as a
   * Wrangler secret and read only by the subscription egress branch —
   * the container holds a placeholder credentials.json, never the token.
   * Named accounts: CLAUDE_SUBSCRIPTION_TOKEN_<ACCOUNT> (resolved by name,
   * not declared here). Unset means no subscription account is provisioned.
   */
  CLAUDE_SUBSCRIPTION_TOKEN?: string;
  /** T48: per-deploy model override for the claude-subscription harness. */
  CLAUDE_SUBSCRIPTION_MODEL?: string;
  /**
   * T49 opt-in flag (§18.11): "1" registers the codex-subscription harness.
   * A distinct var so an operator can enable one subscription provider
   * without the other; absent it is unregistered and unselectable.
   */
  SHIBA_CODEX_SUBSCRIPTION?: string;
  /**
   * T49 credential: the auth.json file contents produced by `codex login`,
   * stored verbatim as a Wrangler secret and read only by the subscription
   * egress branch — the container's CODEX_HOME holds a stub auth.json,
   * never the real tokens. Named accounts:
   * CODEX_SUBSCRIPTION_AUTH_JSON_<ACCOUNT> (resolved by name).
   */
  CODEX_SUBSCRIPTION_AUTH_JSON?: string;
  /** T49: per-deploy model override for the codex-subscription harness. */
  CODEX_SUBSCRIPTION_MODEL?: string;
  /**
   * T50 opt-in flag (§18.12): "1" registers the antigravity-subscription
   * harness and opens the /api/auth/antigravity-subscription verbs plus the
   * /api/antigravity/callback route. No credential var exists — Google
   * OAuth tokens are written by the ACP process into the container
   * profile, never stored on the Worker.
   */
  SHIBA_ANTIGRAVITY_SUBSCRIPTION?: string;
  /** T50: per-deploy model override for the antigravity-subscription harness. */
  ANTIGRAVITY_SUBSCRIPTION_MODEL?: string;
  /**
   * Opt-in flag: "1" opens the /api/auth/cursor-subscription lane.
   * Absent the surface is dark — 404 as if unregistered.
   */
  SHIBA_CURSOR_SUBSCRIPTION?: string;
  /**
   * Credential: the operator's Cursor Agent API key (cursor.com settings),
   * stored as a Wrangler secret and read only by the subscription egress
   * branch — the container holds a dummy CURSOR_API_KEY, never the token.
   * Named accounts: CURSOR_SUBSCRIPTION_TOKEN_<ACCOUNT> (resolved by name,
   * not declared here). Unset means no subscription account is provisioned.
   */
  CURSOR_SUBSCRIPTION_TOKEN?: string;
  /** Per-deploy model override for the cursor-subscription lane. */
  CURSOR_SUBSCRIPTION_MODEL?: string;
  /**
   * Opt-in flag: "1" opens the /api/auth/devin-subscription lane.
   * Absent the surface is dark — 404 as if unregistered.
   */
  SHIBA_DEVIN_SUBSCRIPTION?: string;
  /**
   * Credential: the operator's Devin API key/session token, stored as a
   * Wrangler secret and read only by the subscription egress branch —
   * the container holds a dummy credentials.toml, never the token.
   * Named accounts: DEVIN_SUBSCRIPTION_TOKEN_<ACCOUNT> (resolved by name,
   * not declared here). Distinct from DEVIN_API_KEY, the deployment-wide
   * credential the plain devin harness uses.
   */
  DEVIN_SUBSCRIPTION_TOKEN?: string;
  /** Per-deploy model override for the devin-subscription lane. */
  DEVIN_SUBSCRIPTION_MODEL?: string;
  /**
   * Optional. Devin account API key for the devin harness — injected as a
   * Bearer header by the egress forwarders on api.devin.ai and
   * server.codeium.com. Never sent to containers; the sandboxed CLI holds a
   * dummy credentials.toml. Unset means devin runs fail auth honestly.
   */
  DEVIN_API_KEY?: string;
  /** Optional. Verifies incoming GitHub webhook signatures. */
  GITHUB_WEBHOOK_SECRET?: string;
  /**
   * Optional. Bearer token for POST /api/trigger — external HTTP clients
   * (e.g. an iPhone Apple Shortcut) queue approvals with it. Unset disables
   * the route with a 503.
   */
  TRIGGER_TOKEN?: string;
  /**
   * Optional. When set, require Cloudflare Access identity on every path
   * except authenticated integrations. When both Access settings are unset,
   * only loopback requests bypass identity checks.
   */
  REQUIRE_ACCESS?: string;
  /**
   * Optional. Access application AUD tag. When set, identity comes only from a
   * verified `Cf-Access-Jwt-Assertion`, and Access is required as with REQUIRE_ACCESS.
   */
  ACCESS_AUD?: string;
  /**
   * Optional. Turns on the built-in dashboard auth lane (better-auth.ts):
   * email+password accounts and signed-cookie sessions served at
   * /api/auth/*, backed by the AGENT_AUDIT D1 database. The library
   * requires ≥32 chars — anything shorter is treated as unset and the gate
   * fails closed as before. Access still takes precedence when configured.
   */
  BETTER_AUTH_SECRET?: string;
  /**
   * Optional. Canonical public URL of the dashboard (e.g.
   * `https://app.tryshiba.dev`), used by Better Auth for cookie scope and
   * origin validation. Unset falls back to each request's own origin.
   */
  BETTER_AUTH_URL?: string;
}
