import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleSandboxRoutes, isValidSandboxId } from "../src/sandbox-routes.js";
import type { Env } from "../src/env.js";

const mocks = vi.hoisted(() => ({
  getContainerPlacementId: vi.fn(),
  listProcesses: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: () => ({
    getContainerPlacementId: mocks.getContainerPlacementId,
    listProcesses: mocks.listProcesses,
    listFiles: mocks.listFiles,
    readFile: mocks.readFile,
    exec: mocks.exec,
  }),
}));

function makeEnv(): Env {
  return {
    Sandbox: {} as any,
  } as Env;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isValidSandboxId", () => {
  it("accepts valid sandbox identifiers", () => {
    expect(isValidSandboxId("sb-1234")).toBe(true);
    expect(isValidSandboxId("repo-owner-branch-call-1")).toBe(true);
    expect(isValidSandboxId("a_b.c-123")).toBe(true);
  });

  it("rejects malicious or invalid identifiers", () => {
    expect(isValidSandboxId("")).toBe(false);
    expect(isValidSandboxId("../evil")).toBe(false);
    expect(isValidSandboxId("sb/123")).toBe(false);
    expect(isValidSandboxId("sb;rm -rf")).toBe(false);
  });
});

describe("handleSandboxRoutes", () => {
  it("returns null for non-sandbox paths", async () => {
    const env = makeEnv();
    const req = new Request("https://internal/api/other");
    expect(await handleSandboxRoutes(req, env)).toBeNull();
  });

  it("handles GET /api/sandboxes/:id/info", async () => {
    mocks.getContainerPlacementId.mockResolvedValue("us-east-1");
    mocks.listProcesses.mockResolvedValue([{ pid: 1, command: "node", status: "running" }]);

    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/test-sb-1/info");
    const res = await handleSandboxRoutes(req, env);
    expect(res).not.toBeNull();
    expect(res?.status).toBe(200);
    const body = await res?.json() as any;
    expect(body.available).toBe(true);
    expect(body.placementId).toBe("us-east-1");
    expect(body.processes).toHaveLength(1);
    expect(body.defaultPort).toBe(3000);
  });

  it("handles GET /api/sandboxes/:id/files", async () => {
    mocks.listFiles.mockResolvedValue({
      files: [{ name: "package.json", path: "/workspace/package.json", isDirectory: false, size: 1024 }],
    });

    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/test-sb-1/files?path=/workspace");
    const res = await handleSandboxRoutes(req, env);
    expect(res?.status).toBe(200);
    const body = await res?.json() as any;
    expect(body.files).toHaveLength(1);
    expect(body.files[0].name).toBe("package.json");
  });

  it("handles GET /api/sandboxes/:id/file", async () => {
    mocks.readFile.mockResolvedValue({
      content: "console.log('hello world');",
    });

    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/test-sb-1/file?path=/workspace/src/index.ts");
    const res = await handleSandboxRoutes(req, env);
    expect(res?.status).toBe(200);
    const body = await res?.json() as any;
    expect(body.content).toBe("console.log('hello world');");
  });

  it("requires path parameter for file reading", async () => {
    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/test-sb-1/file");
    const res = await handleSandboxRoutes(req, env);
    expect(res?.status).toBe(400);
  });

  it("handles POST /api/sandboxes/:id/exec", async () => {
    mocks.exec.mockResolvedValue({
      exitCode: 0,
      stdout: "On branch main\nnothing to commit",
      stderr: "",
    });

    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/test-sb-1/exec", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "git status" }),
    });
    const res = await handleSandboxRoutes(req, env);
    expect(res?.status).toBe(200);
    const body = await res?.json() as any;
    expect(body.success).toBe(true);
    expect(body.stdout).toContain("On branch main");
  });

  it("handles GET /api/sandboxes/:id/diff", async () => {
    mocks.exec.mockResolvedValue({
      exitCode: 0,
      stdout: "diff --git a/file b/file\n+line",
      stderr: "",
    });

    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/test-sb-1/diff");
    const res = await handleSandboxRoutes(req, env);
    expect(res?.status).toBe(200);
    const body = await res?.json() as any;
    expect(body.diff).toContain("diff --git");
  });

  it("rejects invalid sandbox id", async () => {
    const env = makeEnv();
    const req = new Request("https://internal/api/sandboxes/invalid%20id%20with%20spaces/info");
    const res = await handleSandboxRoutes(req, env);
    expect(res?.status).toBe(400);
  });
});

