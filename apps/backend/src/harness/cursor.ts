/**
 * Cursor harness — Cursor Agent CLI (`cursor-agent`) in ACP mode.
 *
 * `cursor-agent acp` serves Agent Client Protocol over stdio; the shared
 * driver in acp.ts does initialize → session/new → session/prompt inside the
 * container and this file only supplies the wiring. The CLI is installed with
 * `-f --force` so its edit tools never block headless (t3code's "full-access"
 * runtime mode — the Cloudflare Sandbox is already the isolation boundary).
 *
 * Auth: the CLI reads CURSOR_API_KEY from the environment, so no in-band
 * `authenticate` call is needed — the env carries the dummy key and the
 * Worker's egress forwarder overwrites Authorization on the two Cursor hosts.
 * Verified against t3code (CursorAcpSupport.ts): spawn argv is
 * `cursor-agent [--force] acp`; model "auto" is the CLI's own default and is
 * never sent to session/set_model.
 */
import { AcpHarness } from "./acp.js";

/**
 * Hosts the CLI calls: api2.cursor.sh is the control/API plane, repo2.cursor.sh
 * the repo/context backend. PROVIDER_HOSTS.cursor carries the first; the
 * second rides along via extraEgressHosts so allowedHosts never widens past
 * this pair.
 */
export const CURSOR_EGRESS_HOSTS = ["api2.cursor.sh", "repo2.cursor.sh"] as const;

export const cursorHarness = new AcpHarness({
  name: "cursor",
  binary: "cursor-agent",
  acpArgv: ["-f", "acp"],
  provider: "cursor",
  keyEnv: "CURSOR_API_KEY",
  authMethodId: null,
  // "auto" tells the CLI to pick the model itself; it is a picker value, not
  // a session/set_model id.
  cliManagedModels: ["auto"],
  extraEgressHosts: [CURSOR_EGRESS_HOSTS[1]],
});
