import { describe, expect, it, vi } from "vitest";
import {
  captureRunPreview,
  screenshotKeyFor,
  screenshotUrlFor,
  PREVIEW_PORT,
  type CaptureDeps,
} from "../src/screenshot.js";
import type { Env } from "../src/env.js";

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

function makeDeps(): CaptureDeps & {
  page: {
    goto: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    setRequestInterception: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  };
  requestHandler: { current: ((request: unknown) => void) | undefined };
  proc: { waitForPort: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn> };
  sandbox: {
    startProcess: ReturnType<typeof vi.fn>;
    exposePort: ReturnType<typeof vi.fn>;
    unexposePort: ReturnType<typeof vi.fn>;
  };
} {
  const requestHandler: { current: ((request: unknown) => void) | undefined } = { current: undefined };
  const page = {
    goto: vi.fn(async () => ({})),
    screenshot: vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
    setRequestInterception: vi.fn(async () => undefined),
    on: vi.fn((_event: string, handler: (request: unknown) => void) => {
      requestHandler.current = handler;
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
  return {
    sandbox,
    launch: vi.fn(async () => browser),
    page,
    proc,
    requestHandler,
  };
}

describe("captureRunPreview", () => {
  it("serves the workdir, exposes the port, screenshots, and stores the PNG", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const result = await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps);

    expect(deps.sandbox.startProcess).toHaveBeenCalledWith(
      `python3 -m http.server ${PREVIEW_PORT} --bind 127.0.0.1`,
      { cwd: "/workspace/sandbox-abc123" },
    );
    expect(deps.sandbox.exposePort).toHaveBeenCalledWith(PREVIEW_PORT, {
      hostname: "shiba.example.com",
    });
    expect(deps.page.setRequestInterception).toHaveBeenCalledWith(true);
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
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
    expect(deps.proc.kill).toHaveBeenCalled();
    expect(result).toEqual({
      previewUrl: `https://${PREVIEW_PORT}-sandbox-abc123-tok.shiba.example.com`,
      screenshotUrl: "https://shiba.example.com/api/screenshots/sandbox-abc123",
      screenshotKey: "screenshots/sandbox-abc123.png",
    });
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
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
    expect(deps.proc.kill).toHaveBeenCalled();
  });

  it("returns null on R2 failure without throwing", async () => {
    const env = makeEnv();
    (env.ATTACHMENTS.put as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("r2 boom"));
    const deps = makeDeps();
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.sandbox.unexposePort).toHaveBeenCalledWith(PREVIEW_PORT);
    expect(deps.proc.kill).toHaveBeenCalled();
  });

  it("still kills the process when the port was never exposed", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    deps.proc.waitForPort.mockRejectedValueOnce(new Error("port never came up"));
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.sandbox.unexposePort).not.toHaveBeenCalled();
    expect(deps.proc.kill).toHaveBeenCalled();
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

  it("continues preview-origin requests and aborts external ones", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps);
    const handler = deps.requestHandler.current;
    expect(handler).toBeDefined();

    const internal = {
      url: () => `https://${PREVIEW_PORT}-sandbox-abc123-tok.shiba.example.com/app.js`,
      abort: vi.fn(async () => undefined),
      continue: vi.fn(async () => undefined),
    };
    handler?.(internal);
    expect(internal.continue).toHaveBeenCalled();
    expect(internal.abort).not.toHaveBeenCalled();

    const external = {
      url: () => "https://evil.example.com/tracker.js",
      abort: vi.fn(async () => undefined),
      continue: vi.fn(async () => undefined),
    };
    handler?.(external);
    expect(external.abort).toHaveBeenCalled();
    expect(external.continue).not.toHaveBeenCalled();
  });

  it("returns null without rendering when the page cannot intercept requests", async () => {
    const env = makeEnv();
    const deps = makeDeps();
    const { setRequestInterception: _i, on: _o, ...barePage } = deps.page;
    const browser = { newPage: vi.fn(async () => barePage), close: vi.fn(async () => undefined) };
    (deps.launch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(browser);
    expect(await captureRunPreview(env, { sandboxId: "sandbox-abc123" }, deps)).toBeNull();
    expect(deps.page.goto).not.toHaveBeenCalled();
    expect(env.ATTACHMENTS.put).not.toHaveBeenCalled();
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
