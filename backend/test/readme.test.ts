import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const README = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "README.md"), "utf8");

describe("README structure (T24 honest-ship contract)", () => {
  it("keeps the deploy button pointing at this repo", () => {
    expect(README).toContain("https://deploy.workers.cloudflare.com/button");
    expect(README).toContain("?url=https://github.com/princepal9120/shiba");
  });

  it("states the standard-4 platform ceiling", () => {
    expect(README).toContain("standard-4");
    expect(README).toContain("4 vCPU");
    expect(README).toContain("12 GiB");
    expect(README).toContain("20 GB");
  });

  it("lists ordered prerequisites including the Access bypass", () => {
    // Exact signature-authenticated paths, matching SIGNATURE_AUTHENTICATED.
    expect(README).toContain("/api/slack/events");
    expect(README).toContain("/api/slack/command");
    expect(README).toContain("/api/github/webhook");
    expect(README).toContain("GITHUB_TOKEN");
  });

  it("stays honest: local prototype with P2/P3 runs cited, not claimed", () => {
    expect(README).toContain("local prototype");
    expect(README).toContain("VERIFICATION.md");
    expect(README).toContain("No live end-to-end cloud run is claimed");
    expect(README).toContain("P2");
    expect(README).toContain("P3");
  });

  it("has no stale pre-T4 claims", () => {
    expect(README).not.toContain("disabled (503)");
    expect(README).not.toContain("WORKER_ORIGIN");
    expect(README).not.toContain("providerBaseUrl");
  });

  it("names the current coding model default and the per-harness provider rule", () => {
    expect(README).toContain("google/gemini-3.5-flash-lite");
    expect(README).toContain("AGENT_HARNESS");
    // T23 removed the google-only lock-in; the README must not re-assert it.
    expect(README).not.toContain("Only google/* coding models are accepted");
    expect(README).not.toContain("limited to `google/*`");
  });

  it("states that subscription credentials are not proxied", () => {
    expect(README).toContain("API-key harnesses only");
    expect(README).toContain("Free, Pro, or Max");
  });

  it("does not claim Slack events or automations are unbuilt", () => {
    expect(README).not.toContain("There is no Automations Durable Object");
    expect(README).toContain("SLACK_APPROVERS");
  });

  it("pins the versions that couple to the run contract", () => {
    expect(README).toContain("opencode-ai@1.18.31");
    expect(README).toContain("@cloudflare/sandbox@0.12.9");
  });

  it("documents the Slack slash command without claiming unbuilt surfaces", () => {
    expect(README).toContain("/api/slack/command");
    expect(README).toContain("/shiba-ai-coworker");
    // Shipped surfaces are named; unproven ones stay labelled unverified.
    expect(README).toContain("/api/slack/events");
    expect(README).toContain("No P3 live workspace verification is claimed");
  });
});
