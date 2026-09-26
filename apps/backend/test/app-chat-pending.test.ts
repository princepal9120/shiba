import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Regression guard for the one-shot 403 on
// /agents/coding-orchestrator/identity-pending/get-messages.
//
// useAgentChat's prefetch gate is `getInitialMessages ? true : !!agentUrl`.
// The pending placeholder URL is truthy, so making getInitialMessages
// conditional on `orchestratorName === null` only covers the pending render —
// on the transition render (name resolved, socket object still holding the
// old URL for one render) the default fetch fires against identity-pending
// and the Worker correctly 403s it. The callback must therefore be
// unconditional and gate on the resolved `name` instead.
const appSource = readFileSync(
  join(import.meta.dirname, "..", "..", "frontend", "src", "app.tsx"),
  "utf8",
);

describe("app chat initial-message prefetch", () => {
  it("disables the socket until identity resolves", () => {
    expect(appSource).toContain("enabled: orchestratorName !== null");
  });

  it("never lets the default prefetch fire while the placeholder name is in use", () => {
    // A conditional `cond ? fn : undefined` re-exposes the default fetch on
    // the transition render — that is the regression.
    expect(appSource).not.toMatch(
      /getInitialMessages:\s*[^;]*\?\s*[^;]*:\s*undefined/,
    );
  });

  it("gates the prefetch on the name the request would actually hit", () => {
    expect(appSource).toMatch(/name !== orchestratorName/);
    expect(appSource).toContain("get-messages");
  });
});
