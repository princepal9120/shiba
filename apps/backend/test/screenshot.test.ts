import { describe, expect, it, vi } from "vitest";
import {
  captureRunPreview,
  screenshotKeyFor,
  screenshotUrlFor,
  PREVIEW_PORT,
  type CaptureDeps,
} from "../src/screenshot.js";
import type { Env } from "../src/env.js";

// The real modules transitively import `cloudflare:*` specifiers that Node's
// ESM loader cannot resolve; deps are injected, so the mocks only satisfy the
// module-level bindings.
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: vi.fn() } }));

function makeEnv(overrides: Partial<Env> = {}): Env {
  const store = new Map<string, unknown>();
  return {
    BROWSER: { fetch: vi.fn() } as unknown as Fetcher,
    ATTACHMENTS: {
      put: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
    } as unknown as R2Bucket,
    WORKER_HOSTNAME: "shiba.example.com",
    ...overrides,
  } as unknown as Env;
}

interface MockInterceptedRequest {
  url(): string;
  isInterceptResolutionHandled(): boolean;
  continue(): Promise<void>;
  abort(): Promise<void>;
}

function makeDeps(): CaptureDeps & {
  page: {
    goto: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    setRequestInterception: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  sandbox: {
    startProcess: ReturnType<typeof vi.fn>;
    exposePort: ReturnType<typeof vi.fn>;
    unexposePort: ReturnType<typeof vi.fn>;
  };
  proc: { waitForPort: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
  /** Fire a synthetic intercepted request at the page's request handler. */
  fireRequest(url: string, opts?: { abortRejects?: boolean }): MockInterceptedRequest;
} {
  let requestHandler: ((request: MockInterceptedRequest) => void) | undefined;
  const page = {
    goto: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    setRequestInterception: vi.fn(async () => undefined),
    on: vi.fn((_event: string, handler: (request: MockInterceptedRequest) => void) => {
      requestHandler = handler;
    }),
  };
  const browser = { newPage: vi.fn(async () => page), close: vi.fn(async () => undefined) };
  const proc = { waitForPort: vi.fn(async () => undefined), kill: vi.fn(async () => undefined) };
  const sandbox = {
    exec: vi.fn(async () => ({ exitCode: 0 })),
    startProcess: vi.fn(async () => proc),
    exposePort: vi.fn(async () => ({
      url: `https://${PREVIEW_PORT}-sandbox-abc123-tok.shiba.example.com`,
    })),
    unexposePort: vi.fn(async () => undefined),
  };
  const fireRequest = (url: string, opts?: { abortRejects?: boolean }): MockInterceptedRequest => {
    let handled = false;
    const request: MockInterceptedRequest = {
      url: () => url,
      isInterceptResolutionHandled: () => handled,
      continue: vi.fn(async () => {
        handled = true;
      }) as unknown as () => Promise<void>,
      abort: vi.fn(async () => {
        handled = true;
        if (opts?.abortRejects) throw new Error("session closed");
      }) as unknown as () => Promise<void>,
    };
    requestHandler?.(request);
    return request;
  };
  return {
    sandbox,
    launch: vi.fn(async () => browser),
    page,
    proc,
    fireRequest,
  };
}

describe("captureRunPreview", () => {
  it("serves the workdir, exposes the port, screenshots, and stores the PNG", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const result = await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps);

    expect(deps.sandbox.startProcess).toHaveBeenCalledWith(
      `python3 -m http.server ${PREVIEW_PORT} --bind 0.0.0.0`,
      { cwd: "/workspace/sandbox-abc123" },
    );
    expect(deps.sandbox.exposePort).toHaveBeenCalledWith(PREVIEW_PORT, {
      hostname: "shiba.example.com",
    });
    expect(deps.page.goto).toHaveBeenCalledWith(
      `https://${PREVIEW_PORT}-sandbox-abc123-tok.shiba.example.com`,
      expect.objectContaining({ waitUntil: "networkidle0" }),
    );
    expect(deps.page.screenshot).toHaveBeenCalledWith({ fullPage: false });
    expect(env.ATTACHMENTS.put).toHaveBeenCalledWith(
      "screenshots/sandbox-abc123.png",
      expect.any(Uint8Array),
      { httpMetadata: { contentType: "image/png" } },
    );
    expect(result).toEqual({
      previewUrl: `https://${PREVIEW_PORT}-sandbox-abc123-tok.shiba.example.com`,
      screenshotUrl: "https://shiba.example.com/api/screenshots/sandbox-abc123",
      screenshotKey: "screenshots/sandbox-abc123.png",
    });
    // The preview URL dies at both layers with the render: authorization is
    // revoked on the DO and the workdir server is stopped.
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
    expect(deps.proc.kill).toHaveBeenCalled();
    // The render page must be locked to its own origin.
    expect(deps.page.setRequestInterception).toHaveBeenCalledWith(true);
    expect(deps.page.on).toHaveBeenCalledWith("request", expect.any(Function));
  });

  it("aborts cross-origin requests and continues same-origin ones", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps);

    const sameOrigin = deps.fireRequest(
      `https://${PREVIEW_PORT}-sandbox-abc123-tok.shiba.example.com/app.js`,
    );
    expect(sameOrigin.continue).toHaveBeenCalled();
    expect(sameOrigin.abort).not.toHaveBeenCalled();

    const crossOrigin = deps.fireRequest("https://evil.example.net/exfil?token=abc");
    expect(crossOrigin.abort).toHaveBeenCalled();
    expect(crossOrigin.continue).not.toHaveBeenCalled();

    // Non-network schemes carry no cross-origin traffic and pass through.
    const inline = deps.fireRequest("data:image/png;base64,iVBORw0KGgo=");
    expect(inline.continue).toHaveBeenCalled();
    expect(inline.abort).not.toHaveBeenCalled();
  });

  it("aborts non-http network schemes — ws/wss/file cannot exfiltrate", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps);

    for (const url of [
      "ws://evil.example.net/socket",
      "wss://evil.example.net/socket",
      "file:///etc/passwd",
      "javascript:alert(1)",
    ]) {
      const request = deps.fireRequest(url);
      expect(request.abort).toHaveBeenCalled();
      expect(request.continue).not.toHaveBeenCalled();
    }
    for (const url of ["data:image/png;base64,AAA", "blob:https://x.example/1", "about:blank"]) {
      const request = deps.fireRequest(url);
      expect(request.continue).toHaveBeenCalled();
      expect(request.abort).not.toHaveBeenCalled();
    }
  });

  it("still unexposes the preview port when navigation fails", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    deps.page.goto.mockRejectedValueOnce(new Error("TimeoutError: 60000ms"));
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
  });

  it("swallows async abort/continue rejections in the request listener", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps);

    // The listener wraps allowSameOriginOnly in .catch(): a rejected abort
    // (both the policy abort and the fail-closed fallback abort) must stay
    // contained, never an unhandled rejection.
    const request = deps.fireRequest("https://evil.example.net/beacon", { abortRejects: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(request.abort).toHaveBeenCalled();
  });

  it("fails closed when request interception cannot be enabled", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    deps.page.setRequestInterception.mockRejectedValueOnce(new Error("unsupported"));
    // A render without the same-origin policy must never happen: capture
    // returns null, nothing is stored, and the preview is still revoked.
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.page.goto).not.toHaveBeenCalled();
    expect(env.ATTACHMENTS.put).not.toHaveBeenCalled();
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
    expect(deps.proc.kill).toHaveBeenCalled();
  });

  it("still unexposes the preview port when exposePort itself fails", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    deps.sandbox.exposePort.mockRejectedValueOnce(new Error("expose boom"));
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    // unexposePort is idempotent: revoke even when exposure never completed.
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
    expect(deps.proc.kill).toHaveBeenCalled();
  });

  it("returns null when BROWSER is not bound", async () => {
    const env = makeEnv({ BROWSER: undefined });
    const deps = makeDeps();
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.sandbox.startProcess).not.toHaveBeenCalled();
  });

  it("returns null when WORKER_HOSTNAME is unset", async () => {
    const env = makeEnv({ WORKER_HOSTNAME: "" });
    const deps = makeDeps();
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.sandbox.exposePort).not.toHaveBeenCalled();
  });

  it("returns null on navigation failure without throwing", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    deps.page.goto.mockRejectedValueOnce(new Error("TimeoutError: 60000ms"));
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(env.ATTACHMENTS.put).not.toHaveBeenCalled();
    // The throwaway workdir server must still be stopped on the failure path.
    expect(deps.proc.kill).toHaveBeenCalled();
  });

  it("returns null on R2 failure without throwing", async () => {
    const env = makeEnv();
    (env.ATTACHMENTS.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("r2 boom"));
    const deps = makeDeps();
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
  });

  it("closes the browser even when screenshot throws", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const browser = { newPage: vi.fn(async () => deps.page), close: vi.fn(async () => undefined) };
    (deps.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(browser);
    deps.page.screenshot.mockRejectedValueOnce(new Error("screenshot failed"));
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(browser.close).toHaveBeenCalled();
  });
});

describe("screenshotUrlFor", () => {
  it("builds an absolute URL on the worker hostname", () => {
    const env = makeEnv();
    expect(screenshotUrlFor(env, "sandbox-abc123")).toBe(
      "https://shiba.example.com/api/screenshots/sandbox-abc123",
    );
  });

  it("returns null without a hostname", () => {
    expect(screenshotUrlFor(makeEnv({ WORKER_HOSTNAME: undefined }), "x")).toBeNull();
  });

  it("keys the object by sandbox id", () => {
    expect(screenshotKeyFor("sandbox-abc123")).toBe("screenshots/sandbox-abc123.png");
  });
});
