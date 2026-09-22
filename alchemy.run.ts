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
 * Deploy-time secrets (the `wrangler secret put` set): `secrets(NAMES)`
 * binds each present `NAME` as `secret_text`; unset names are skipped,
 * matching optional env entries.
 * `Redacted.make` is used instead of Config helpers — it exists on both
 * effect 3 (this repo) and effect 4 (alchemy's declared peer).
 *
 * Worker name: pinned to "ai-intern" so the first deploy adopts the
 * wrangler-managed script in place (a pinned `name` is used verbatim — no
 * stage suffix). On any non-live stage ($ALCHEMY_STAGE) the name is
 * suffixed instead, so `alchemy deploy --stage test-*` / `destroy` can
 * never clobber the live worker — the same isolation the wrangler
 * ephemeral deploys got from a name override.
 *
 * State backend: `Alchemy.localState()` (filesystem) by default — it works
 * with a plain CLOUDFLARE_API_TOKEN and no bootstrap step. Set
 * ALCHEMY_STATE_BACKEND=cloudflare to opt back into the remote State
 * Store after a one-time `npx alchemy provider cloudflare bootstrap`
 * (needs a token with the account Secrets Store scope).
 */
import { Effect, Redacted } from "effect";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import type { CodingOrchestrator } from "./src/agents/orchestrator.js";
import type { OpenCodeAgent } from "./src/agents/opencode-agent.js";
import type { Sandbox } from "./src/sandbox.js";

const secrets = (names: readonly string[]) => {
  const entries: Record<string, ReturnType<typeof Redacted.make>> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) entries[name] = Redacted.make(value);
  }
  return entries;
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

    ...secrets([
      "GITHUB_TOKEN",
      "GITHUB_WEBHOOK_SECRET",
      "SLACK_SIGNING_SECRET",
      "SLACK_APPROVERS",
      "SLACK_BOT_TOKEN",
      "SLACK_CHANNEL_REPOS",
      "TYPESAFE_API_KEY",
      "AI_GATEWAY_TOKEN",
      "DEVIN_API_KEY",
      "REQUIRE_ACCESS",
      "AUTOMATIONS_ENABLED",
      "AGENT_HARNESS",
      "CLAUDE_CODE_MODEL",
      "CODEX_MODEL",
      "DEVIN_MODEL",
    ]),
  },
});

export type WorkerEnv = Cloudflare.InferEnv<typeof Worker>;

export default Alchemy.Stack(
  "ai-intern",
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
    const worker = yield* Worker;
    return { url: worker.url };
  }).pipe(Alchemy.AdoptPolicy.adopt(stage === undefined || /^live(_|$)/.test(stage))),
);
