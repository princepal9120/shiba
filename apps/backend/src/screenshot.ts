/**
 * PR screenshot capture (megaplan T33). After the coding run completes,
 * serve the workdir over a throwaway static server inside the sandbox,
 * mint a preview URL with `sandbox.exposePort`, render it once through
 * Workers Browser Rendering (puppeteer), and stash the PNG in the
 * ATTACHMENTS bucket keyed `screenshots/{sandboxId}.png`.
 *
 * Every entry point is fail-safe: missing bindings, a dead sandbox, a
 * navigation timeout, or an R2 failure all resolve to `null` — never a
 * thrown error — so capture can never fail a run or its PR publish.
 */
import { getSandbox } from "@cloudflare/sandbox";
import puppeteer from "@cloudflare/puppeteer";
import type { Env } from "./env.js";
import { isValidSandboxId } from "./sandbox-routes.js";

/**
 * Port the in-sandbox static server binds. Deliberately NOT 3000: that is the
 * container's `defaultPort` (src/sandbox.ts), reserved for whatever the run's
 * own dev server binds, so a preview server on the same port would collide.
 */
export const PREVIEW_PORT = 8080;
const NAV_TIMEOUT_MS = 60_000;
const PORT_READY_TIMEOUT_MS = 30_000;

export interface PreviewCapture {
  /** Public sandbox preview URL (`{port}-{sandboxId}-{token}.{host}`). */
  previewUrl: string;
  /** Absolute URL that serves the stored PNG on this Worker, or null when no hostname is configured. */
  screenshotUrl: string | null;
  /** ATTACHMENTS object key the PNG was written to. */
  screenshotKey: string;
}

export const screenshotKeyFor = (sandboxId: string): string => `screenshots/${sandboxId}.png`;

/** Absolute public URL for a stored screenshot on this Worker. */
export function screenshotUrlFor(env: Env, sandboxId: string): string | null {
  const host = env.WORKER_HOSTNAME?.trim();
  if (!host) return null;
  return `https://${host}/api/screenshots/${encodeURIComponent(sandboxId)}`;
}

/**
 * Request-interception policy for the render page: continue same-origin
 * requests (the page's own HTML, CSS, JS, images on the preview server) and
 * abort everything else so untrusted workdir content cannot issue
 * cross-origin network requests. Schemes that never reach the network
 * (data:, blob:, about:) are allowed through; ws:/wss:/file: are not —
 * a WebSocket handshake is cross-origin traffic the same-origin check
 * cannot see, and file: reads must not leave the renderer.
 */
async function allowSameOriginOnly(request: InterceptedRequest, previewUrl: string): Promise<void> {
  if (request.isInterceptResolutionHandled()) return;
  try {
    const target = new URL(request.url());
    const isHttp = target.protocol === "http:" || target.protocol === "https:";
    // Non-network schemes (data:, blob:, about:) never leave the renderer.
    const isNonNetwork = target.protocol === "data:" || target.protocol === "blob:" || target.protocol === "about:";
    const allowed = isNonNetwork || (isHttp && target.origin === new URL(previewUrl).origin);
    if (allowed) {
      await request.continue();
    } else {
      await request.abort();
    }
  } catch {
    // Unparseable URL or a resolution race: block rather than guess.
    if (!request.isInterceptResolutionHandled()) {
      await request.abort().catch(() => undefined);
    }
  }
}

interface PreviewSandbox {
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ exitCode: number }>;
  startProcess(
    command: string,
    options?: { cwd?: string },
  ): Promise<{
    waitForPort(port: number, options?: { timeout?: number }): Promise<void>;
    kill?(): Promise<void>;
  }>;
  exposePort(port: number, options: { hostname: string }): Promise<{ url: string }>;
  /** Idempotent: revokes preview URL authorization for a port. */
  unexposePort(port: number): Promise<void>;
}

/** Minimal intercepted-request surface used for the same-origin policy. */
interface InterceptedRequest {
  url(): string;
  isInterceptResolutionHandled(): boolean;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface PuppeteerPage {
  goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  screenshot(options?: { fullPage?: boolean; type?: string }): Promise<ArrayBuffer | Uint8Array>;
  setRequestInterception(value: boolean): Promise<void>;
  on(event: "request", handler: (request: InterceptedRequest) => void): unknown;
}

interface PuppeteerBrowser {
  newPage(): Promise<PuppeteerPage>;
  close(): Promise<void>;
}

export interface CaptureDeps {
  sandbox?: PreviewSandbox;
  launch?: (browser: Fetcher) => Promise<PuppeteerBrowser>;
  screenshotTimeoutMs?: number;
}

/**
 * Serve `/workspace/{sandboxId}` in the sandbox, expose the preview port,
 * screenshot the page, and store the PNG. Returns null on any failure or
 * when `BROWSER`/`WORKER_HOSTNAME` are unconfigured — the caller never
 * branches on failure because failure and "not configured" look identical.
 */
export async function captureRunPreview(
  env: Env,
  input: { sandboxId: string; workdir?: string },
  deps: CaptureDeps = {},
): Promise<PreviewCapture | null> {
  try {
    if (!env.BROWSER || !env.ATTACHMENTS) return null;
    const hostname = env.WORKER_HOSTNAME?.trim();
    if (!hostname || !isValidSandboxId(input.sandboxId)) return null;

    const sandbox = deps.sandbox ?? (getSandbox(env.Sandbox, input.sandboxId) as unknown as PreviewSandbox);
    const workdir = input.workdir ?? `/workspace/${input.sandboxId}`;

    // A static server is the honest preview of what the run produced: it
    // needs no package install and survives repos without a dev script.
    // It MUST bind 0.0.0.0: exposePort forwarding dials the container through
    // getTcpPort on its external interface, so a loopback-only server is
    // unreachable no matter how valid the preview token is.
    const proc = await sandbox.startProcess(
      `python3 -m http.server ${PREVIEW_PORT} --bind 0.0.0.0`,
      { cwd: workdir },
    );
    // The static server exposes the whole workdir to anyone holding the
    // tokenized preview URL, so it must live only as long as the single
    // render below. Everything from here to `proc.kill()` is one span.
    let png: ArrayBuffer | Uint8Array;
    let previewUrl: string;
    try {
      await proc.waitForPort(PREVIEW_PORT, { timeout: PORT_READY_TIMEOUT_MS });

      // exposePort persists `{port}-{sandboxId}-{token}.{hostname}` on the DO;
      // proxyToSandbox resolves it publicly without an Access identity.
      previewUrl = (await sandbox.exposePort(PREVIEW_PORT, { hostname })).url;

      const launch = deps.launch ?? ((b: Fetcher) => puppeteer.launch(b) as unknown as Promise<PuppeteerBrowser>);
      const browser = await launch(env.BROWSER);
      try {
        const page = await browser.newPage();
        // Untrusted workdir HTML must not phone home: any request that is not
        // same-origin with the preview URL (trackers, CDNs, exfil beacons) is
        // aborted, so the rendered page can only reach its own server.
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          // Sync listener: swallow the async resolution so a rejected
          // continue/abort can never surface as an unhandled rejection.
          allowSameOriginOnly(request, previewUrl).catch(() => undefined);
        });
        await page.goto(previewUrl, { waitUntil: "networkidle0", timeout: deps.screenshotTimeoutMs ?? NAV_TIMEOUT_MS });
        png = await page.screenshot({ fullPage: false });
      } finally {
        await browser.close().catch(() => undefined);
      }
    } finally {
      // Revoke the public preview URL authorization and stop serving the
      // workdir the moment the PNG exists (or the attempt failed): the URL
      // dies at both layers, so a leaked token reaches nothing. unexposePort
      // is idempotent, so it is safe even when exposePort itself failed.
      await sandbox.unexposePort(PREVIEW_PORT).catch(() => undefined);
      await proc.kill?.().catch(() => undefined);
    }

    const screenshotKey = screenshotKeyFor(input.sandboxId);
    await env.ATTACHMENTS.put(screenshotKey, png, {
      httpMetadata: { contentType: "image/png" },
    });
    return {
      previewUrl,
      screenshotUrl: screenshotUrlFor(env, input.sandboxId),
      screenshotKey,
    };
  } catch (error) {
    // Failure-safe contract (T33): log and degrade to no-screenshot.
    console.error(
      `Preview screenshot capture failed for sandbox ${input.sandboxId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
