import { afterEach, describe, expect, it, vi } from "vitest";

const sandboxMock = vi.hoisted(() => ({ getSandbox: vi.fn() }));
vi.mock("@cloudflare/sandbox", () => ({ getSandbox: sandboxMock.getSandbox, streamFile: vi.fn() }));
vi.mock("@cloudflare/ai-chat", () => ({ AIChatAgent: class {} }));

import { createSandboxOps } from "../src/agents/opencode-agent.js";
import {
  HARNESS_RETRY,
  RetryExhaustedError,
  backoffDelayMs,
  classifyRetryable,
  withRetry,
  type RetryPolicy,
} from "../src/harness/retry.js";
import type { CodingTaskInput } from "../src/opencode-input.js";
import { classifyRunError } from "../src/run-errors.js";
import { SandboxRuntimeAdapter, type SandboxOps } from "../src/runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const FAST: RetryPolicy = { maxAttempts: 3, baseDelayMs: 5, maxDelayMs: 20, retryIf: classifyRetryable };

function abortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

describe("withRetry", () => {
  it("returns the first success without retrying or delaying", async () => {
    let calls = 0;
    const started = Date.now();
    const result = await withRetry(FAST, async () => {
      calls += 1;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("retries a retryable failure with a real delay, then succeeds", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // jitter at its ceiling: exact capped delay
    let calls = 0;
    const started = Date.now();
    const result = await withRetry({ ...FAST, baseDelayMs: 15 }, async () => {
      calls += 1;
      if (calls === 1) throw new Error("provider returned status 503: overloaded");
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(8);
  });

  it("does not retry a terminal failure and rethrows it untouched", async () => {
    const failure = new Error("status 401: unauthorized");
    let calls = 0;
    await expect(
      withRetry(FAST, async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("never retries an AbortError even though the policy would", async () => {
    const failure = abortError();
    let calls = 0;
    await expect(
      withRetry({ ...FAST, retryIf: () => true }, async () => {
        calls += 1;
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(calls).toBe(1);
  });

  it("stops promptly when the caller's signal aborts during the backoff wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    const pending = withRetry(
      { maxAttempts: 3, baseDelayMs: 60_000, maxDelayMs: 60_000, retryIf: () => true },
      async () => {
        calls += 1;
        controller.abort();
        throw new Error("status 503: overloaded");
      },
      controller.signal,
    );
    await expect(pending).rejects.toThrow(/cancelled/i);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not retry a retryable error once the signal has aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withRetry(FAST, async () => {
        calls += 1;
        controller.abort();
        throw new Error("status 503: overloaded");
      }, controller.signal),
    ).rejects.toThrow(/cancelled/i);
    expect(calls).toBe(1);
  });

  it("refuses to run the task at all on a pre-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      withRetry(FAST, async () => {
        calls += 1;
        return "unreachable";
      }, controller.signal),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });

  it("throws RetryExhaustedError carrying the last error after maxAttempts", async () => {
    const last = new Error("status 503: still overloaded");
    let calls = 0;
    const error = await withRetry(FAST, async () => {
      calls += 1;
      throw last;
    }).then(
      () => new Error("unreachable"),
      (caught: unknown) => caught,
    );
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect((error as Error).name).toBe("RetryExhaustedError");
    expect((error as RetryExhaustedError).attempts).toBe(3);
    expect((error as RetryExhaustedError).cause).toBe(last);
    // The classifier already maps this name to the exhaustion code.
    expect(classifyRunError(error).code).toBe("supervision_exhausted");
  });

  it("rethrows the last error verbatim when retryIf stops matching mid-budget", async () => {
    const terminal = new Error("status 401: unauthorized");
    let calls = 0;
    await expect(
      withRetry(FAST, async () => {
        calls += 1;
        throw calls === 1 ? new Error("status 500") : terminal;
      }),
    ).rejects.toBe(terminal);
    expect(calls).toBe(2);
  });
});

describe("backoffDelayMs", () => {
  const policy: RetryPolicy = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 250, retryIf: () => true };

  it("grows exponentially from baseDelayMs", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(backoffDelayMs(policy, 1)).toBe(100);
    expect(backoffDelayMs(policy, 2)).toBe(200);
  });

  it("never exceeds maxDelayMs even at the jitter ceiling", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    // 100 * 2^(3-1) = 400, capped at 250.
    expect(backoffDelayMs(policy, 3)).toBe(250);
    expect(backoffDelayMs(policy, 8)).toBe(250);
  });

  it("jitters inside [0, cap] and never above it", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(backoffDelayMs(policy, 8)).toBe(0);
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(backoffDelayMs(policy, 2)).toBe(100);
  });
});

describe("classifyRetryable", () => {
  it.each([
    [new Error("provider returned status 503"), true],
    [new Error("provider returned status 429"), true],
    [new Error("HTTP 408 timed out"), true],
    [new Error("upstream failed with status 500"), true],
    [new Error("status 401: unauthorized"), false],
    [new Error("status 404: no such route"), false],
    [new Error("status 400: bad request"), false],
    [new Error("sandbox oomkilled"), false],
    [new Error("run timed out waiting for the executor"), false],
    [new Error("plain internal boom"), false],
    [new Error("status 401: token expired"), false],
    [new Error("Cloudflare API failed: code 10400"), false],
  ])("maps %j -> %s", (error, expected) => {
    expect(classifyRetryable(error)).toBe(expected);
  });

  it("never retries abort or an already-exhausted budget", () => {
    expect(classifyRetryable(abortError())).toBe(false);
    const exhausted = new Error("budget spent");
    exhausted.name = "RetryExhaustedError";
    expect(classifyRetryable(exhausted)).toBe(false);
  });
});

describe("HARNESS_RETRY", () => {
  it("is a 3-attempt budget with the run-error classifier as the retry gate", () => {
    expect(HARNESS_RETRY.maxAttempts).toBe(3);
    expect(HARNESS_RETRY.retryIf).toBe(classifyRetryable);
    expect(HARNESS_RETRY.baseDelayMs).toBeGreaterThan(0);
    expect(HARNESS_RETRY.maxDelayMs).toBeGreaterThanOrEqual(HARNESS_RETRY.baseDelayMs);
  });
});

const INPUT: CodingTaskInput = {
  repoUrl: "https://github.com/owner/repo",
  task: "Fix it.",
  baseBranch: "main",
  publishPullRequest: false,
  sandboxId: "run-abcdef12345678",
  codingModel: "google/gemini-3.5-flash-lite",
};

function makeFakeOps(overrides: Partial<SandboxOps> = {}): SandboxOps {
  return {
    async gitCheckout() {},
    async writeFile() {},
    async exec(command) {
      if (command.includes("status")) {
        return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("diff")) {
        return { stdout: "diff --git a/src/a.ts", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile() {
      return { kind: "utf8", content: "file content" };
    },
    ...overrides,
  };
}

describe("withRetry wired into the runtime adapter", () => {
  it("does not retry a nonzero harness exitCode — the verdict is data, not an error", async () => {
    let opencodeCalls = 0;
    const ops = makeFakeOps({
      async exec(command) {
        if (command.includes("opencode")) {
          opencodeCalls += 1;
          return { stdout: "", stderr: "failed", exitCode: 7 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("error");
    expect(result.exitCode).toBe(7);
    expect(opencodeCalls).toBe(1);
  });

  it("retries the harness exec on a thrown transient failure", async () => {
    let opencodeCalls = 0;
    const ops = makeFakeOps({
      async exec(command) {
        if (command.includes("opencode")) {
          opencodeCalls += 1;
          if (opencodeCalls === 1) throw new Error("provider returned status 503: overloaded");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command.includes("diff")) return { stdout: "", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("completed");
    expect(opencodeCalls).toBe(2);
  });

  it("does not retry a thrown terminal failure at the harness exec", async () => {
    let opencodeCalls = 0;
    const ops = makeFakeOps({
      async exec(command) {
        if (command.includes("opencode")) {
          opencodeCalls += 1;
          throw new Error("status 401: unauthorized");
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("error");
    expect(opencodeCalls).toBe(1);
  });

  it("retries diff collection on a thrown transient failure", async () => {
    let statusCalls = 0;
    const ops = makeFakeOps({
      async exec(command) {
        if (command.includes("status")) {
          statusCalls += 1;
          if (statusCalls === 1) throw new Error("provider returned status 503: overloaded");
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        if (command.includes("diff")) return { stdout: "diff --git a/x", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    });
    const result = await new SandboxRuntimeAdapter().runCodingTask(ops, INPUT, () => {});
    expect(result.status).toBe("completed");
    expect(statusCalls).toBe(2);
  });
});

describe("withRetry wired into createSandboxOps.gitCheckout", () => {
  it("retries the egress-pin + clone pair as one operation", async () => {
    const calls: string[] = [];
    const approveHarnessEgress = vi.fn(async () => {
      calls.push("egress");
    });
    const approveRepoScope = vi.fn(async () => {
      calls.push("scope");
      if (calls.filter((c) => c === "scope").length === 1) {
        throw new Error("provider returned status 503: overloaded");
      }
    });
    const gitCheckout = vi.fn(async () => {
      calls.push("clone");
    });
    sandboxMock.getSandbox.mockReturnValue({ approveHarnessEgress, approveRepoScope, gitCheckout });
    await createSandboxOps({} as never, INPUT.sandboxId, ["api.anthropic.com"])
      .gitCheckout(INPUT.repoUrl, { branch: "main", targetDir: "/workspace" });
    // The failed scope re-ran the whole pair: egress approval is part of the
    // retried unit, so the second attempt re-pins egress before cloning.
    expect(calls).toEqual(["egress", "scope", "egress", "scope", "clone"]);
    expect(gitCheckout).toHaveBeenCalledOnce();
  });

  it("does not retry a terminal failure from the container-start pair", async () => {
    const approveRepoScope = vi.fn(async () => {
      throw new Error("status 401: unauthorized");
    });
    const gitCheckout = vi.fn();
    sandboxMock.getSandbox.mockReturnValue({ approveRepoScope, gitCheckout });
    await expect(
      createSandboxOps({} as never, INPUT.sandboxId)
        .gitCheckout(INPUT.repoUrl, { branch: "main", targetDir: "/workspace" }),
    ).rejects.toThrow("status 401");
    expect(approveRepoScope).toHaveBeenCalledOnce();
    expect(gitCheckout).not.toHaveBeenCalled();
  });

  it("still refuses a non-GitHub repo instead of retrying it", async () => {
    const gitCheckout = vi.fn();
    sandboxMock.getSandbox.mockReturnValue({ gitCheckout });
    await expect(
      createSandboxOps({} as never, INPUT.sandboxId)
        .gitCheckout("https://evil.example.com/owner/repo", { branch: "main", targetDir: "/workspace" }),
    ).rejects.toThrow();
    expect(gitCheckout).not.toHaveBeenCalled();
  });
});
