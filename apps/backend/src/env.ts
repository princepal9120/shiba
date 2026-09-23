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
   * Bound to the McpGateway Durable Object class in wrangler.jsonc — the
   * `/mcp` tool surface for external agents (megaplan T5, see
   * `mcp-gateway.ts`). One instance per MCP session id.
   */
  McpGateway: DurableObjectNamespace;
  /**
   * Bound to the Memory Durable Object class in wrangler.jsonc — one stub
   * per agent name plus the shared "global" registry that indexes fact ids
   * across agents (megaplan T8, see `memory-do.ts`).
   */
  Memory: DurableObjectNamespace;
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
  /** "sandbox" (default) or "computer" (preview-only refusal). */
  RUNTIME?: string;
  /**
   * Deploy-time container size. Must match wrangler `containers.instance_type`.
   * lite | basic | standard-1 | standard-2 | standard-3 | standard-4.
   */
  INSTANCE_TYPE?: string;
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
  /** Optional. JSON map `{channelId: "https://github.com/owner/repo"}` for bare mentions. */
  SLACK_CHANNEL_REPOS?: string;
  /** Optional. TypeSafe System One key for `run_when`; unset falls back to Workers AI. */
  TYPESAFE_API_KEY?: string;
  /** Optional. Required only to open pull requests. Never sent to containers. */
  GITHUB_TOKEN?: string;
  /** Optional. Server-side credential for AI Gateway. Never sent to containers. */
  AI_GATEWAY_TOKEN?: string;
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
   * Optional. When set, require Cloudflare Access identity on every path
   * except SIGNATURE_AUTHENTICATED. Unset for `wrangler dev`.
   */
  REQUIRE_ACCESS?: string;
  /**
   * Optional. Access application AUD tag. When set, identity comes only from a
   * verified `Cf-Access-Jwt-Assertion`, and Access is required as with REQUIRE_ACCESS.
   */
  ACCESS_AUD?: string;
}
