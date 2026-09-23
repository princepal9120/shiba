import { describe, expect, it, vi } from "vitest";
import {
  SLACK_DEFAULT_PUBLISH_PR,
  buildSlackRunPayload,
  buildSlackThreadName,
  getSlackThreadStub,
  missingGithubTokenWarning,
  resolveThreadTs,
} from "../src/slack-thread.js";

describe("buildSlackThreadName", () => {
  it("names the DO slack:{team}:{channel}:{thread_ts}", () => {
    expect(buildSlackThreadName("T123", "C456", "1758217392.000100")).toBe(
      "slack:T123:C456:1758217392.000100",
    );
  });

  it("gives each thread its own conversation (distinct names)", () => {
    const a = buildSlackThreadName("T123", "C456", "1758217392.000100");
    const b = buildSlackThreadName("T123", "C456", "1758217400.000200");
    expect(a).not.toBe(b);
  });

  it("is stable for the same thread (history/approval/runs attach to one DO)", () => {
    expect(buildSlackThreadName("T123", "C456", "1758217392.000100")).toBe(
      buildSlackThreadName("T123", "C456", "1758217392.000100"),
    );
  });

  it("rejects empty team, channel, or thread ids", () => {
    expect(() => buildSlackThreadName("", "C456", "1758217392.000100")).toThrow();
    expect(() => buildSlackThreadName("T123", "", "1758217392.000100")).toThrow();
    expect(() => buildSlackThreadName("T123", "C456", "")).toThrow();
  });

  it("rejects a malformed thread_ts", () => {
    expect(() => buildSlackThreadName("T123", "C456", "not-a-ts")).toThrow();
    expect(() => buildSlackThreadName("T123", "C456", "12345")).toThrow();
  });
});

describe("resolveThreadTs", () => {
  it("prefers thread_ts when the mention is already in a thread", () => {
    expect(resolveThreadTs({ thread_ts: "1758217392.000100", ts: "1758217400.000200" })).toBe(
      "1758217392.000100",
    );
  });

  it("falls back to ts when a top-level mention starts the thread", () => {
    expect(resolveThreadTs({ ts: "1758217400.000200" })).toBe("1758217400.000200");
  });

  it("returns null when no timestamp is present", () => {
    expect(resolveThreadTs({})).toBeNull();
  });
});

describe("slack run payload", () => {
  it("requests a PR by default on the Slack path", () => {
    expect(SLACK_DEFAULT_PUBLISH_PR).toBe(true);
    const payload = buildSlackRunPayload({
      repoUrl: "https://github.com/owner/repo",
      task: "Fix the login bug",
    });
    expect(payload.publishPullRequest).toBe(true);
    expect(payload.source).toBe("slack");
    expect(payload.repoUrl).toBe("https://github.com/owner/repo");
  });
});

describe("missingGithubTokenWarning", () => {
  it("warns on the card when GITHUB_TOKEN is missing (approve would fail after click)", () => {
    const warning = missingGithubTokenWarning({});
    expect(warning).not.toBeNull();
    expect(warning!).toContain("GITHUB_TOKEN");
  });

  it("is silent when GITHUB_TOKEN is configured", () => {
    expect(missingGithubTokenWarning({ GITHUB_TOKEN: "ghp_example" })).toBeNull();
  });
});

describe("getSlackThreadStub", () => {
  it("resolves the orchestrator DO by thread name", async () => {
    const stub = { fetch: vi.fn() };
    const byName = vi.fn(async (_ns: unknown, _name: string) => stub);
    const result = await getSlackThreadStub(
      { CodingOrchestrator: {} } as never,
      { teamId: "T123", channelId: "C456", threadTs: "1758217392.000100" },
      byName as never,
    );
    expect(result).toBe(stub);
    expect(byName).toHaveBeenCalledOnce();
    expect(byName.mock.calls[0]?.[1]).toBe("slack:T123:C456:1758217392.000100");
  });
});
