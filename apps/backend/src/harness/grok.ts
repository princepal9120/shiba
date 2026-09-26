/**
 * Grok harness — xAI's Grok CLI (`grok`, npm @xai-official/grok) in ACP mode.
 *
 * `grok agent stdio` serves Agent Client Protocol; the shared driver in acp.ts
 * runs initialize → authenticate → session/new → session/prompt inside the
 * container. `--permission-mode auto` keeps tool execution non-interactive —
 * the Cloudflare Sandbox is the isolation boundary (t3code's "auto" runtime
 * mode, GrokAcpSupport.ts).
 *
 * Auth: ACP `authenticate` with methodId "xai.api_key" — the CLI reads the key
 * from XAI_API_KEY, which here holds the dummy; the real key is injected by
 * AI Gateway egress on api.x.ai.
 */
import { AcpHarness } from "./acp.js";

export const grokHarness = new AcpHarness({
  name: "grok",
  binary: "grok",
  acpArgv: ["--permission-mode", "auto", "agent", "stdio"],
  provider: "xai",
  keyEnv: "XAI_API_KEY",
  authMethodId: "xai.api_key",
});
