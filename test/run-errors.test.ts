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
  it("projects outcome_unknown to status unknown, others to error", () => {
    expect(runErrorWire("outcome_unknown").status).toBe("unknown");
    for (const code of ALL_CODES.filter((c) => c !== "outcome_unknown")) {
      expect(runErrorWire(code).status).toBe("error");
    }
  });

  it("carries exactly {status, code, userMessage} with no raw error text", () => {
    const wire = runErrorWire("rate_limit_exceeded");
    expect(Object.keys(wire).sort()).toEqual(["code", "status", "userMessage"]);
    expect(wire.code).toBe("rate_limit_exceeded");
    expect(wire.userMessage).toBe(RUN_ERROR_DEFS.rate_limit_exceeded.summary);
  });
});
