import { describe, expect, it } from "vitest";

import { OpenCodeErrorEvent } from "../src/harness/opencode.js";
import { CodexErrorEvent } from "../src/harness/codex.js";
import {
  classifyExecutorError,
  classifyRunError,
  RUN_ERROR_DEFS,
  runErrorWire,
  statusToRunCode,
  type RunErrorCode,
} from "../src/run-errors.js";

const ALL_CODES: RunErrorCode[] = [
  "authentication_error",
  "resource_not_found",
  "request_timeout",
  "rate_limit_exceeded",
  "server_overloaded",
  "server_error",
  "invalid_request",
  "executor_failed",
  "outcome_unknown",
  "egress_denied",
  "cancelled",
  "internal_error",
  "container_lost",
  "credential_expired",
  "quota_exhausted",
  "timeout_scope",
  "supervision_exhausted",
];

describe("statusToRunCode", () => {
  it.each([
    [401, "authentication_error"],
    [403, "authentication_error"],
    [404, "resource_not_found"],
    [408, "request_timeout"],
    [429, "rate_limit_exceeded"],
    [503, "server_overloaded"],
    [529, "server_overloaded"],
    [500, "server_error"],
    [502, "server_error"],
    [400, "invalid_request"],
    [422, "invalid_request"],
    [null, "internal_error"],
  ] as const)("maps %s -> %s", (status, code) => {
    expect(statusToRunCode(status)).toBe(code);
  });
});

describe("classifyRunError", () => {
  it("maps harness errors with an explicit HTTP status to the status code", () => {
    const err = new OpenCodeErrorEvent("provider returned status 429: too many requests");
    expect(classifyRunError(err).code).toBe("rate_limit_exceeded");
    expect(classifyRunError(new CodexErrorEvent("HTTP 503")).code).toBe("server_overloaded");
  });

  it("maps harness errors without a status to executor_failed", () => {
    expect(classifyRunError(new OpenCodeErrorEvent("model exploded")).code).toBe("executor_failed");
  });

  it("maps abort errors to cancelled", () => {
    const abort = new Error("Run cancelled.");
    abort.name = "AbortError";
    expect(classifyRunError(abort).code).toBe("cancelled");
    expect(classifyRunError(new DOMException("aborted", "AbortError")).code).toBe("cancelled");
  });

  it("maps plain errors and junk to internal_error and never throws", () => {
    expect(classifyRunError(new Error("boom")).code).toBe("internal_error");
    expect(classifyRunError(null).code).toBe("internal_error");
    expect(classifyRunError(42).code).toBe("internal_error");
    expect(classifyRunError({ weird: true }).code).toBe("internal_error");
    expect(classifyRunError("a string").code).toBe("internal_error");
    expect(classifyRunError(undefined).code).toBe("internal_error");
  });

  it.each([
    ["502 files changed"],
    ["commit abc5021 landed"],
    ["listening on port 8443"],
    ["took 3500ms"],
  ])("does not over-match bare digits: %s", (message) => {
    const code = classifyRunError(new OpenCodeErrorEvent(message)).code;
    expect(code).toBe("executor_failed");
  });

  it("extracts status context anywhere in the message", () => {
    expect(classifyRunError(new OpenCodeErrorEvent("fail: status=404 at clone")).code).toBe(
      "resource_not_found",
    );
    expect(classifyRunError(new OpenCodeErrorEvent("status code: 408")).code).toBe("request_timeout");
  });

  it("maps an explicit 401 with an expired credential to credential_expired", () => {
    expect(
      classifyRunError(new Error("provider returned status 401: token expired")).code,
    ).toBe("credential_expired");
    expect(classifyRunError(new Error("HTTP 401 — credential EXPIRED")).code).toBe(
      "credential_expired",
    );
  });

  it("keeps a 401 without 'expired' as authentication_error", () => {
    expect(classifyRunError(new Error("status 401 unauthorized")).code).toBe(
      "authentication_error",
    );
  });

  it("does not classify 'expired' without explicit HTTP context", () => {
    expect(classifyRunError(new Error("credential expired")).code).toBe("internal_error");
  });

  it.each([
    "Cloudflare API failed: code 10400",
    "status 10400 quota exceeded",
    "error 10400: container limit",
    "code=10400",
    "errno 10400",
  ])("maps Cloudflare quota code 10400 in context: %s", (message) => {
    expect(classifyRunError(new Error(message)).code).toBe("quota_exhausted");
  });

  it.each([
    "10400 files scanned",
    "saw 10400 on the dashboard",
  ])("does not over-match a bare 10400: %s", (message) => {
    expect(classifyRunError(new Error(message)).code).toBe("internal_error");
    expect(classifyRunError(new OpenCodeErrorEvent(message)).code).toBe("executor_failed");
  });

  it.each([
    "sandbox exited: SIGKILL",
    "process oomkilled",
    "OOMKilled by the kernel",
    "OOM killed, status 500",
    "worker hit OOM limit",
    "out of memory in container",
    "out of memory in the sandbox",
    "container out-of-memory condition",
  ])("maps container death signals: %s", (message) => {
    expect(classifyRunError(new Error(message)).code).toBe("container_lost");
  });

  it.each([
    "boom",
    "zoom meeting error",
    "JavaScript heap out of memory",
    "CUDA out of memory",
    "Out-of-memory condition",
  ])("does not over-match container death substrings: %s", (message) => {
    expect(classifyRunError(new Error(message)).code).toBe("internal_error");
  });

  it("lets a strong content signal beat the harness-name fallback", () => {
    // The container-death signal is stronger than the envelope class.
    expect(classifyRunError(new OpenCodeErrorEvent("OOMKilled")).code).toBe("container_lost");
  });

  it("maps a RetryExhaustedError name to supervision_exhausted", () => {
    const err = new Error("gave up after 3 attempts");
    err.name = "RetryExhaustedError";
    expect(classifyRunError(err).code).toBe("supervision_exhausted");
  });

  it("lets the RetryExhaustedError name win over an embedded status", () => {
    const err = new Error("attempts failed with status 500");
    err.name = "RetryExhaustedError";
    expect(classifyRunError(err).code).toBe("supervision_exhausted");
  });

  it.each([
    "Run exceeded its 45-minute deadline and was reclaimed; side effects are unverified",
    "run timed out waiting for the executor",
    "run timeout was exceeded",
    "run deadline was missed",
    "run exceeded the timeout limit",
    "run hit the timeout",
    "overall timeout for the run",
    "overall deadline hit for run abc123",
    "run was reclaimed after its deadline passed",
  ])("maps overall-run timeout language: %s", (message) => {
    expect(classifyRunError(new Error(message)).code).toBe("timeout_scope");
  });

  it.each([
    "deadline estimator crashed",
    "the deadline field was renamed",
    "the run deadline was extended",
    "the run timeout is 900s",
    "we missed the deadline",
    "deadline exceeded",
  ])("does not over-match unrelated deadline/timeout text: %s", (message) => {
    expect(classifyRunError(new Error(message)).code).toBe("internal_error");
  });
});

describe("classifyExecutorError", () => {
  it("maps an unclassified structured failure to executor_failed", () => {
    expect(classifyExecutorError(new Error("sandbox crashed without detail")).code).toBe("executor_failed");
    expect(classifyExecutorError("plain string failure").code).toBe("executor_failed");
  });

  it("still honors explicit statuses and aborts", () => {
    expect(classifyExecutorError(new Error("upstream returned status 429")).code).toBe("rate_limit_exceeded");
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(classifyExecutorError(abort).code).toBe("cancelled");
  });

  it("delegates the new codes through classifyRunError", () => {
    const retry = new Error("budget exhausted");
    retry.name = "RetryExhaustedError";
    expect(classifyExecutorError(retry).code).toBe("supervision_exhausted");
    expect(classifyExecutorError(new Error("container oomkilled")).code).toBe("container_lost");
    expect(classifyExecutorError(new Error("status 401: key expired")).code).toBe(
      "credential_expired",
    );
  });
});

describe("RUN_ERROR_DEFS", () => {
  it("is exhaustive over RunErrorCode", () => {
    for (const code of ALL_CODES) {
      const def = RUN_ERROR_DEFS[code];
      expect(def, code).toBeDefined();
      expect(typeof def.userFacing).toBe("boolean");
      expect(def.summary.length).toBeGreaterThan(0);
    }
  });
});

describe("runErrorWire", () => {
  it("projects indeterminate codes to status unknown, others to error", () => {
    expect(runErrorWire("outcome_unknown").status).toBe("unknown");
    expect(runErrorWire("container_lost").status).toBe("unknown");
    for (const code of ALL_CODES.filter(
      (c) => c !== "outcome_unknown" && c !== "container_lost",
    )) {
      expect(runErrorWire(code).status, code).toBe("error");
    }
  });

  it.each(["rate_limit_exceeded", "container_lost"] as const)(
    "carries exactly {status, code, userMessage} with no raw error text: %s",
    (code) => {
      const wire = runErrorWire(code);
      expect(Object.keys(wire).sort()).toEqual(["code", "status", "userMessage"]);
      expect(wire.code).toBe(code);
      expect(wire.userMessage).toBe(RUN_ERROR_DEFS[code].summary);
    },
  );
});
