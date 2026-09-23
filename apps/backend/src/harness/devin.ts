/**
 * Devin CLI harness — runs Cognition's Devin agent inside the sandbox.
 *
 * Unlike the provider harnesses, Devin is a service CLI: it authenticates to
 * Cognition's backends with an account API key rather than driving an LLM
 * provider directly. The credential invariant is unchanged — the container's
 * credentials.toml carries a dummy key and the real DEVIN_API_KEY is injected
 * as a Bearer header by the Worker's egress handlers (src/egress.ts) on the
 * two hosts the CLI calls: api.devin.ai (control plane) and
 * server.codeium.com (inference backend for Pro accounts).
 *
 * Verified against devin 3000.10.31: `devin auth status` reports the
 * credentials file as `$XDG_DATA_HOME/devin/credentials.toml` with keys
 * windsurf_api_key / api_server_url / devin_webapp_host / devin_api_url, and
 * api.devin.ai accepts `Authorization: Bearer <key>` (verified 200 on
 * /v3/self). `-p` prints a plain-text response, not an event stream.
 */
import type { CodingTaskInput } from "../opencode-input.js";
import { DUMMY_PROVIDER_KEY } from "../provider-gateway.js";
import { boundTail } from "../security.js";
import {
  assertSupportedModel,
  PROVIDER_KEY_ENV,
  type AgentHarness,
  type HarnessConfigFile,
} from "./types.js";

/** Devin is its own provider namespace: codingModel is "devin/<model-alias>". */
export const DEVIN_PROVIDERS = ["devin"] as const;

/** Hosts the CLI needs: control plane plus the inference backend. */
export const DEVIN_EGRESS_HOSTS = ["api.devin.ai", "server.codeium.com"] as const;

/** XDG_DATA_HOME inside the container; credentials.toml lands under it. */
const CONTAINER_XDG_DATA = "/workspace/.xdg-data";

/** Thrown when a streamed Devin line reports an auth or run failure. */
export class DevinErrorEvent extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = "DevinErrorEvent";
    this.detail = detail;
  }
}

/** First-run banner lines that are noise, not progress. */
const BANNER = /^\s*(?:✓\s*)?(?:Welcome to Devin CLI|Logged in as|Organization:|You're all set)/;

/** Lines that mean the run cannot succeed — surface them as honest errors. */
const FATAL = /Not logged in|Login failed|Account verification failed|Authentication timed out/i;

/**
 * `devin -p` emits plain text, not JSONL: each non-empty line is progress.
 * Banner lines are dropped; auth failures throw so the run reports error
 * instead of pretending success.
 */
export function parseDevinEvent(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (BANNER.test(trimmed)) return null;
  if (FATAL.test(trimmed)) {
    throw new DevinErrorEvent(boundTail(trimmed, 500));
  }
  return boundTail(trimmed, 500);
}

/** "devin/swe-2" → "swe-2" — the CLI takes bare aliases after --model. */
function devinModelAlias(codingModel: string): string {
  return codingModel.slice("devin/".length);
}

export class DevinHarness implements AgentHarness {
  readonly name = "devin" as const;
  readonly supportedProviders = DEVIN_PROVIDERS;

  egressHosts(model: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, model);
    return [...DEVIN_EGRESS_HOSTS];
  }

  /**
   * The dummy credentials file. The real key never enters the container —
   * the egress forwarders overwrite Authorization on the two Devin hosts.
   */
  configFile(_input: CodingTaskInput, _sandboxId: string): HarnessConfigFile {
    return {
      path: CONTAINER_XDG_DATA + "/devin/credentials.toml",
      contents: [
        'windsurf_api_key = "dummy-egress-swapped"',
        'api_server_url = "https://server.codeium.com"',
        'devin_webapp_host = "https://app.devin.ai"',
        'devin_api_url = "https://api.devin.ai"',
        "",
      ].join("\n"),
    };
  }

  env(input: CodingTaskInput, _configPath: string | null): Record<string, string> {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return {
      XDG_DATA_HOME: CONTAINER_XDG_DATA,
      [PROVIDER_KEY_ENV.devin as string]: DUMMY_PROVIDER_KEY,
    };
  }

  /**
   * Headless single-turn run. `bypass` is the container-appropriate mode:
   * the Cloudflare Sandbox is already the isolation boundary, and Devin's own
   * OS sandbox (--sandbox) needs bwrap the image does not ship. Callers quote
   * with shellJoin; never interpolate the task into a shell string by hand.
   */
  buildArgv(input: CodingTaskInput, _workdir: string): string[] {
    assertSupportedModel(this.name, this.supportedProviders, input.codingModel);
    return [
      "devin",
      "-p",
      "--model",
      devinModelAlias(input.codingModel),
      "--permission-mode",
      "bypass",
      "--respect-workspace-trust",
      "false",
      "--",
      input.task,
    ];
  }

  parseEvent(line: string): string | null {
    return parseDevinEvent(line);
  }
}

export const devinHarness = new DevinHarness();
