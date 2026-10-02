/**
 * Isolated repository runtime. Credentials are attached by outbound handlers
 * in the Worker (src/egress.ts), never by the container or its processes.
 */
import { Sandbox as SandboxBase } from "@cloudflare/sandbox";
import {
  denyUnscopedGitHub,
  forwardAnthropic,
  forwardClaudeSubscription,
  forwardCodexSubscription,
  forwardCursorSubscription,
  forwardDevinApi,
  forwardDevinSubscription,
  forwardDevinInference,
  forwardGitHubScoped,
  forwardGoogle,
  forwardOpenAI,
  forwardXAI,
  forwardOpenCodeGo,
} from "./egress.js";
import type { Env as WorkerEnv } from "./env.js";

export class Sandbox<Env = WorkerEnv> extends SandboxBase<Env> {
  override defaultPort = 3000;
  override sleepAfter = "1m";
  override interceptHttps = true;

  /**
   * Deny-by-default egress allowlist. Anything unlisted cannot leave the
   * container, including from repository code OpenCode runs.
   *
   * Instance property (not static): the base Container class declares
   * `allowedHosts?: string[]` as an instance member and the egress gate
   * reads `this.allowedHosts` at runtime.
   */
  // Narrowed per run by approveHarnessEgress to the selected harness's
  // provider host alone; this default covers a run that never narrowed it.
  override allowedHosts = [
    "generativelanguage.googleapis.com",
    "github.com",
    "codeload.github.com", // git clone fetches packs here
  ];

  /**
   * Narrow egress to the selected harness's hosts (T22). A handler mapping is
   * not permission: allowedHosts gates every host before any handler runs.
   */
  async approveHarnessEgress(hosts: string[]): Promise<void> {
    await this.setAllowedHosts(hosts);
  }

  /**
   * T48: per-run outbound-handler overrides from the selected harness —
   * subscription providers swap their hosts onto the token branch (the
   * static map still shows the gateway path for API-key harnesses).
   */
  async approveEgressOverrides(
    overrides: { host: string; handler: string; params?: Record<string, string> }[],
  ): Promise<void> {
    for (const override of overrides) {
      await this.setOutboundByHost(override.host, override.handler, override.params);
    }
  }

  /**
   * Called before the clone. One sandbox id is one task, so the scope is per
   * run; `/${owner}/${repo}` is the only path that gets the credential.
   */
  async approveRepoScope(allowedPath: string): Promise<void> {
    await this.setOutboundByHost("github.com", "githubScoped", { allowedPath });
  }
}

// These must go through the base class setters: Container records handler
// maps in module-level registries keyed by class name, so a `static get`
// override would read correctly but leave runtime dispatch empty.
/** Named handlers addressable by `setOutboundByHost` at run time. */
Sandbox.outboundHandlers = { githubScoped: forwardGitHubScoped, claudeSubscription: forwardClaudeSubscription, codexSubscription: forwardCodexSubscription, cursorSubscription: forwardCursorSubscription, devinSubscription: forwardDevinSubscription };
// github.com defaults to refusal; approveRepoScope swaps in the scoped
// handler for the one repo a run was approved for (B6). Provider hosts are
// mapped for every supported harness, but allowedHosts admits only one.
Sandbox.outboundByHost = {
  "generativelanguage.googleapis.com": forwardGoogle,
  "api.anthropic.com": forwardAnthropic,
  "api.openai.com": forwardOpenAI,
  "api.x.ai": forwardXAI,
  "opencode.ai": forwardOpenCodeGo,
  "api.devin.ai": forwardDevinApi,
  "server.codeium.com": forwardDevinInference,
  "github.com": denyUnscopedGitHub,
};
