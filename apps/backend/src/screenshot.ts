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

/** Port the in-sandbox static server binds. Kept off 3000, which the sandbox
 * reserves as `defaultPort` for the run's own dev server (sandbox-routes). */
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
    kill?(signal?: string): Promise<void>;
  }>;
  exposePort(port: number, options: { hostname: string }): Promise<{ url: string }>;
  unexposePort?(port: number): Promise<void>;
}

interface InterceptedRequest {
  url(): string;
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface PuppeteerBrowser {
  newPage(): Promise<{
    goto(url: string, options?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
    screenshot(options?: { fullPage?: boolean; type?: string }): Promise<ArrayBuffer | Uint8Array>;
    setRequestInterception?(enabled: boolean): Promise<void>;
    on?(event: "request", handler: (request: InterceptedRequest) => void): void;
  }>;
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
    const proc = await sandbox.startProcess(
      `python3 -m http.server ${PREVIEW_PORT} --bind 127.0.0.1`,
      { cwd: workdir },
    );

    // The preview port is publicly reachable once exposed, so its lifetime
    // is bounded by this try: any failure past this point still unexposes it
    // and stops the throwaway static server.
    let exposed = false;
    try {
      await proc.waitForPort(PREVIEW_PORT, { timeout: PORT_READY_TIMEOUT_MS });

      // exposePort persists `{port}-{sandboxId}-{token}.{hostname}` on the DO;
      // proxyToSandbox resolves it publicly without an Access identity.
      const { url: previewUrl } = await sandbox.exposePort(PREVIEW_PORT, { hostname });
      exposed = true;

      const launch = deps.launch ?? ((b: Fetcher) => puppeteer.launch(b) as unknown as Promise<PuppeteerBrowser>);
      const browser = await launch(env.BROWSER);
      let png: ArrayBuffer | Uint8Array;
      try {
        const page = await browser.newPage();
        // Rendered content is untrusted run output; without request
        // interception a page could pull arbitrary external URLs through the
        // rendering browser, so no isolation means no screenshot.
        if (!page.setRequestInterception || !page.on) return null;
        const previewOrigin = new URL(previewUrl).origin;
        await page.setRequestInterception(true);
        page.on("request", (request) => {
          try {
            if (new URL(request.url()).origin === previewOrigin) {
              request.continue().catch(() => undefined);
            } else {
              request.abort().catch(() => undefined);
            }
          } catch {
            request.abort().catch(() => undefined);
          }
        });
        await page.goto(previewUrl, { waitUntil: "networkidle0", timeout: deps.screenshotTimeoutMs ?? NAV_TIMEOUT_MS });
        png = await page.screenshot({ fullPage: false });
      } finally {
        await browser.close().catch(() => undefined);
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
    } finally {
      // Unexpose before killing so the public URL stops resolving even if the
      // process takes a moment to die; both are best-effort because capture
      // has already settled its result by then.
      if (exposed) await sandbox.unexposePort?.(PREVIEW_PORT).catch(() => undefined);
      await proc.kill?.().catch(() => undefined);
    }
  } catch (error) {
    // Failure-safe contract (T33): log and degrade to no-screenshot.
    console.error(
      `Preview screenshot capture failed for sandbox ${input.sandboxId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}
