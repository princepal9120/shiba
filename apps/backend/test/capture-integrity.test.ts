import { describe, expect, it } from "vitest";
import { SandboxRuntimeAdapter } from "../src/runtime.js";
import type { SandboxOps } from "../src/runtime.js";

const INPUT = {
  repoUrl: "https://github.com/owner/repo",
  task: "t",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abc",
  codingModel: "google/gemini-3.5-flash-lite",
};

function opsWithStatus(stdout: string): SandboxOps {
  return {
    async gitCheckout() {},
    async writeFile() {},
    async exec(command) {
      if (command.includes("status")) return { stdout, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { kind: "utf8", content: "x" };
    },
  } as SandboxOps;
}

const stdout = Array.from({ length: 51 }, (_, i) => ` M src/f${i}.ts`).join("\n") + "\n";

describe("capture integrity (#18)", () => {
  it("fails the run instead of publishing past the file cap", async () => {
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(opsWithStatus(stdout), INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.summary).toContain("capture limit");
  });

  it("fails the run when captured content exceeds the char cap", async () => {
    const big = Array.from({ length: 2 }, (_, i) => ` M src/f${i}.ts`).join("\n") + "\n";
    const adapter = new SandboxRuntimeAdapter();
    const result = await adapter.runCodingTask(
      {
        async gitCheckout() {},
        async writeFile() {},
        async exec(command) {
          if (command.includes("status")) return { stdout: big, stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async readFile() {
          return { kind: "utf8", content: "x".repeat(400_000) };
        },
      } as SandboxOps,
      INPUT,
      () => {},
    );
    expect(result.status).toBe("error");
    expect(result.summary).toContain("partial tree");
  });
});
