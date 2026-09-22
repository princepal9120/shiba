/**
 * Alchemy v2 deploy definition — declares the same Cloudflare stack as
 * wrangler.jsonc so `npx alchemy deploy` replaces `npx wrangler deploy`
 * (rollback path: wrangler still deploys the same bindings).
 *
 * wrangler.jsonc -> props mapping:
 *   name                          -> Worker "ai-intern" (live stages; see below)
 *   main                          -> main
 *   compatibility_date/_flags     -> compatibility.{date,flags}
 *   assets.{directory,not_found_handling} -> assets.{directory,notFoundHandling}
 *   preview_urls: false           -> workersDev.previewsEnabled: false
 *   vars                          -> env string entries
 *   ai.binding                    -> env AI: Cloudflare.Workers.AI()
 *   durable_objects.bindings      -> env entries (Cloudflare.DurableObject;
 *                                    Sandbox comes from its Container decl)
 *   containers[]                  -> env Sandbox: Cloudflare.Container(...)
 *   migrations new_sqlite_classes -> emitted automatically by the provider
 *                                    for DO classes new to the script
 *
 * Deploy-time secrets (the `wrangler secret put` set): each `secret(NAME)`
 * below binds `NAME` as `secret_text` only when present in the deploy
 * environment; unset names are skipped, matching optional env entries.
 * `Redacted.make` is used instead of Config helpers — it exists on both
 * effect 3 (this repo) and effect 4 (alchemy's declared peer).
 *
 * Worker name: pinned to "ai-intern" so the first deploy adopts the
 * wrangler-managed script in place (a pinned `name` is used verbatim — no
 * stage suffix). On any non-live stage ($ALCHEMY_STAGE) the name is
 * suffixed instead, so `alchemy deploy --stage test-*` / `destroy` can
 * never clobber the live worker — the same isolation the wrangler
 * ephemeral deploys got from a name override.
 */
import { Effect, Redacted } from "effect";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { CodingOrchestrator } from "./src/agents/orchestrator.js";
import type { OpenCodeAgent } from "./src/agents/opencode-agent.js";
import type { Sandbox } from "./src/sandbox.js";

const secret = (name: string) => {
  const value = process.env[name];
  return value === undefined ? undefined : Redacted.make(value);
};

const stage = process.env.ALCHEMY_STAGE;
const workerName =
  stage === undefined || /^live(_|$)/.test(stage)
    ? "ai-intern"
    : `ai-intern-${stage}`;

export const Worker = Cloudflare.Worker("Worker", {
  name: workerName,
  main: "src/index.ts",
  compatibility: {
    date: "2026-06-01",
    flags: ["nodejs_compat"],
  },
  assets: {
    directory: "./public",
    notFoundHandling: "404-page",
  },
  // Stable workers.dev stays on; `preview_urls: false` in wrangler terms —
  // version previews are reachable without Access, which is not the gate.
  workersDev: { enabled: true, previewsEnabled: false },
  crons: ["*/5 * * * *"],
  env: {
    GATEWAY_ID: "default",
    ORCHESTRATOR_MODEL: "@cf/meta/llama-3.1-8b-instruct",
    CODING_MODEL: "google/gemini-3.5-flash-lite",
    RUNTIME: "sandbox",
    // Must match the Sandbox container's instanceType.
    INSTANCE_TYPE: "standard-1",

    AI: Cloudflare.Workers.AI(),

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

    // wrangler durable_objects.bindings Sandbox + containers[0]: the
    // Container decl is the DO namespace binding plus its container app.
    Sandbox: Cloudflare.Container<Sandbox>("Sandbox", {
      name: "ai-intern-sandbox",
      context: ".",
      dockerfile: "./Dockerfile",
      instanceType: "standard-1",
      maxInstances: 5,
    }),

    GITHUB_TOKEN: secret("GITHUB_TOKEN"),
    GITHUB_WEBHOOK_SECRET: secret("GITHUB_WEBHOOK_SECRET"),
    SLACK_SIGNING_SECRET: secret("SLACK_SIGNING_SECRET"),
    SLACK_APPROVERS: secret("SLACK_APPROVERS"),
    SLACK_BOT_TOKEN: secret("SLACK_BOT_TOKEN"),
    SLACK_CHANNEL_REPOS: secret("SLACK_CHANNEL_REPOS"),
    TYPESAFE_API_KEY: secret("TYPESAFE_API_KEY"),
    AI_GATEWAY_TOKEN: secret("AI_GATEWAY_TOKEN"),
    DEVIN_API_KEY: secret("DEVIN_API_KEY"),
    REQUIRE_ACCESS: secret("REQUIRE_ACCESS"),
    AUTOMATIONS_ENABLED: secret("AUTOMATIONS_ENABLED"),
    AGENT_HARNESS: secret("AGENT_HARNESS"),
    CLAUDE_CODE_MODEL: secret("CLAUDE_CODE_MODEL"),
    CODEX_MODEL: secret("CODEX_MODEL"),
    DEVIN_MODEL: secret("DEVIN_MODEL"),
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "ai-intern",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const worker = yield* Worker;
    return { url: worker.url };
  }),
);
