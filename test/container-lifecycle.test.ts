import { describe, expect, it, vi } from "vitest";
import {
  ContainerReleasedError,
  forgetLeaked,
  leakedContainerCount,
  leakedContainers,
  runWithContainer,
  type ManagedContainer,
} from "../src/sandbox/lifecycle.js";
import type { ExecResult, SandboxOps } from "../src/runtime.js";

function fakeOps() {
  return {
    gitCheckout: vi.fn(async (_repoUrl: string, _opts: { branch: string; targetDir: string }) => {}),
    writeFile: vi.fn(async (_path: string, _content: string) => {}),
    exec: vi.fn(
      async (
        _command: string,
        _opts?: {
          cwd?: string;
          timeoutMs?: number;
          env?: Record<string, string>;
          signal?: AbortSignal;
          onOutput?: (stream: "stdout" | "stderr", data: string) => void;
        },
      ): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 0 }),
    ),
    readFile: vi.fn(
      async (_path: string, _opts?: { maxBytes?: number; signal?: AbortSignal }) =>
        ({ kind: "utf8", content: "" }) as const,
    ),
  } satisfies SandboxOps;
}

describe("runWithContainer", () => {
  it("acquires, runs the task, and releases exactly once after the task", async () => {
    const ops = fakeOps();
    const order: string[] = [];
    const acquire = vi.fn(async () => {
      order.push("acquire");
      return ops;
    });
    const release = vi.fn(async (_sandboxId: string) => {
      order.push("release");
    });
    const result = await runWithContainer(
      { acquire, release, sandboxId: "sbx-order" },
      async (container) => {
        order.push("task");
        expect(container.sandboxId).toBe("sbx-order");
        expect(container.released).toBe(false);
        expect(container.leaked).toBe(false);
        expect(container.generation).toBe(0);
        await container.ops.exec("ls");
        return "done";
      },
    );
    expect(result).toBe("done");
    expect(acquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-order");
    expect(order).toEqual(["acquire", "task", "release"]);
  });

  it("still releases when the task throws, and rethrows the task error", async () => {
    const release = vi.fn(async (_sandboxId: string) => {});
    await expect(
      runWithContainer(
        { acquire: async () => fakeOps(), release, sandboxId: "sbx-throw" },
        async () => {
          throw new Error("task boom");
        },
      ),
    ).rejects.toThrow("task boom");
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-throw");
  });

  it("still releases when the abort signal fires mid-task", async () => {
    const controller = new AbortController();
    const release = vi.fn(async (_sandboxId: string) => {});
    await expect(
      runWithContainer(
        { acquire: async () => fakeOps(), release, sandboxId: "sbx-abort", signal: controller.signal },
        async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        },
      ),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
  });

  it("passes the caller's signal through to ops opts unchanged", async () => {
    const ops = fakeOps();
    const controller = new AbortController();
    const release = vi.fn(async (_sandboxId: string) => {});
    await runWithContainer(
      { acquire: async () => ops, release, sandboxId: "sbx-signal", signal: controller.signal },
      async (container) => {
        await container.ops.exec("ls", { signal: controller.signal });
        await container.ops.readFile("/f", { signal: controller.signal });
      },
    );
    expect(ops.exec).toHaveBeenCalledWith("ls", expect.objectContaining({ signal: controller.signal }));
    expect(ops.readFile).toHaveBeenCalledWith("/f", expect.objectContaining({ signal: controller.signal }));
  });

  it("releases a container acquired with an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const release = vi.fn(async (_sandboxId: string) => {});
    await expect(
      runWithContainer(
        { acquire: async () => fakeOps(), release, sandboxId: "sbx-preaborted", signal: controller.signal },
        async () => {
          controller.signal.throwIfAborted();
        },
      ),
    ).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith("sbx-preaborted");
  });

  it("fences ops after release with ContainerReleasedError and bumps generation", async () => {
    const ops = fakeOps();
    let container: ManagedContainer | undefined;
    await runWithContainer(
      { acquire: async () => ops, release: async () => {}, sandboxId: "sbx-fenced" },
      async (managed) => {
        container = managed;
      },
    );
    expect(container).toBeDefined();
    const released = container!;
    expect(released.released).toBe(true);
    expect(released.leaked).toBe(false);
    expect(released.generation).toBe(1);
    for (const call of [
      () => released.ops.gitCheckout("https://github.com/o/r", { branch: "main", targetDir: "/w" }),
      () => released.ops.writeFile("/f", "x"),
      () => released.ops.exec("ls"),
      () => released.ops.readFile("/f"),
    ]) {
      await expect(call()).rejects.toBeInstanceOf(ContainerReleasedError);
      await expect(call()).rejects.toMatchObject({ name: "ContainerReleasedError" });
    }
    expect(ops.exec).not.toHaveBeenCalled();
    expect(ops.gitCheckout).not.toHaveBeenCalled();
    expect(ops.writeFile).not.toHaveBeenCalled();
    expect(ops.readFile).not.toHaveBeenCalled();
  });

  it("marks the container leaked and records it when release fails", async () => {
    const countBefore = leakedContainerCount();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let container: ManagedContainer | undefined;
    await expect(
      runWithContainer(
        {
          acquire: async () => fakeOps(),
          release: async () => {
            throw new Error("destroy boom");
          },
          sandboxId: "sbx-leak",
        },
        async (managed) => {
          container = managed;
        },
      ),
    ).rejects.toThrow("destroy boom");
    // Capture before mockRestore clears the recorded calls.
    const logged = errorSpy.mock.calls.map((call) => call.join(" ")).join(" ");
    errorSpy.mockRestore();
    expect(container!.released).toBe(true);
    expect(container!.leaked).toBe(true);
    expect(container!.generation).toBe(1);
    expect(leakedContainerCount()).toBe(countBefore + 1);
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-leak")).toBe(true);
    // A leaked container's ops reject the same as a released one's.
    await expect(container!.ops.exec("ls")).rejects.toBeInstanceOf(ContainerReleasedError);
    // The release failure is logged with the sandboxId for later reclaim.
    expect(logged).toContain("sbx-leak");
  });

  it("task error wins over a release failure, and the leak is still recorded", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runWithContainer(
          {
            acquire: async () => fakeOps(),
            release: async () => {
              throw new Error("destroy boom");
            },
            sandboxId: "sbx-doublefail",
          },
          async () => {
            throw new Error("task boom");
          },
        ),
      ).rejects.toThrow("task boom");
    } finally {
      errorSpy.mockRestore();
    }
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-doublefail")).toBe(true);
  });

  it("forgetLeaked drops the registry entry after a successful retry", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        runWithContainer(
          {
            acquire: async () => fakeOps(),
            release: async () => {
              throw new Error("destroy boom");
            },
            sandboxId: "sbx-retry",
          },
          async () => {},
        ),
      ).rejects.toThrow("destroy boom");
    } finally {
      errorSpy.mockRestore();
    }
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-retry")).toBe(true);
    forgetLeaked("sbx-retry");
    expect(leakedContainers().some((entry) => entry.sandboxId === "sbx-retry")).toBe(false);
  });
});
