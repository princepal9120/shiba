import { describe, expect, it } from "vitest";
import {
  applyThreadControls,
  clampBurstWindowSeconds,
  extractGitHubRepoUrl,
  gatherSlackContext,
  groupMessageBursts,
  parseChannelRepoMap,
  resolveSlackRepo,
  type SlackThreadMessage,
} from "../src/slack-context.js";

function msg(user: string, text: string, ts: number): SlackThreadMessage {
  return { user, text, ts };
}

describe("extractGitHubRepoUrl", () => {
  it("finds a GitHub URL in mention text", () => {
    expect(extractGitHubRepoUrl("@ai-intern fix https://github.com/owner/repo please")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("returns null when no URL is present", () => {
    expect(extractGitHubRepoUrl("@ai-intern fix this please")).toBeNull();
  });
});

describe("parseChannelRepoMap", () => {
  it("parses a JSON channel map", () => {
    expect(parseChannelRepoMap('{"C123":"https://github.com/owner/repo"}')).toEqual({
      C123: "https://github.com/owner/repo",
    });
  });

  it("returns empty map for missing or invalid input", () => {
    expect(parseChannelRepoMap(undefined)).toEqual({});
    expect(parseChannelRepoMap("not-json")).toEqual({});
  });
});

describe("resolveSlackRepo", () => {
  it("prefers an explicit URL over the channel default", () => {
    const resolved = resolveSlackRepo({
      mentionText: "@ai-intern fix https://github.com/owner/explicit now",
      threadTexts: ["see https://github.com/owner/threaded"],
      channelId: "C123",
      channelRepos: { C123: "https://github.com/owner/mapped" },
    });
    expect(resolved).toEqual({ kind: "repo", repoUrl: "https://github.com/owner/explicit" });
  });

  it("falls back to the thread URL, then the channel map", () => {
    expect(
      resolveSlackRepo({
        mentionText: "@ai-intern fix this",
        threadTexts: ["context https://github.com/owner/from-thread"],
        channelId: "C123",
        channelRepos: { C123: "https://github.com/owner/mapped" },
      }),
    ).toEqual({ kind: "repo", repoUrl: "https://github.com/owner/from-thread" });

    expect(
      resolveSlackRepo({
        mentionText: "@ai-intern fix this",
        threadTexts: ["no links here"],
        channelId: "C123",
        channelRepos: { C123: "https://github.com/owner/mapped" },
      }),
    ).toEqual({ kind: "repo", repoUrl: "https://github.com/owner/mapped" });
  });

  it("asks when no repo can be resolved, starting no run", () => {
    const resolved = resolveSlackRepo({
      mentionText: "@ai-intern fix this",
      threadTexts: ["no links here"],
      channelId: "C999",
      channelRepos: {},
    });
    expect(resolved.kind).toBe("ask");
    if (resolved.kind === "ask") {
      expect(resolved.message).toMatch(/which repo/i);
      expect(resolved.startRun).toBe(false);
    }
  });
});

describe("burst grouping", () => {
  it("groups a 20-message burst from one author into one run", () => {
    const messages = Array.from({ length: 20 }, (_, i) => msg("U1", `update ${i}`, i));
    expect(groupMessageBursts(messages, { windowSeconds: 10 })).toHaveLength(1);
  });

  it("splits when a different author posts", () => {
    const messages = [msg("U1", "first", 0), msg("U2", "second", 1)];
    expect(groupMessageBursts(messages, { windowSeconds: 10 })).toHaveLength(2);
  });

  it("splits when the sliding window elapses", () => {
    const messages = [msg("U1", "first", 0), msg("U1", "second", 60)];
    expect(groupMessageBursts(messages, { windowSeconds: 10 })).toHaveLength(2);
  });

  it("splits at the 20-message / 100KB bounds", () => {
    const overCount = Array.from({ length: 21 }, (_, i) => msg("U1", `m${i}`, i));
    expect(groupMessageBursts(overCount, { windowSeconds: 10 }).length).toBeGreaterThan(1);

    const big = "x".repeat(60 * 1024);
    const overBytes = [msg("U1", big, 0), msg("U1", big, 1)];
    expect(groupMessageBursts(overBytes, { windowSeconds: 10 })).toHaveLength(2);
  });

  it("clamps the burst window to 1-300s", () => {
    expect(clampBurstWindowSeconds(10)).toBe(10);
    expect(clampBurstWindowSeconds(0)).toBe(1);
    expect(clampBurstWindowSeconds(9999)).toBe(300);
  });
});

describe("thread controls", () => {
  it("excludes `aside` messages from processing entirely", () => {
    const messages = [msg("U1", "aside ignore this", 0), msg("U1", "real work", 1)];
    expect(applyThreadControls(messages).map((m) => m.text)).toEqual(["real work"]);
  });

  it("mute stops replies to non-mention messages until unmute", () => {
    const messages = [
      msg("U1", "mute", 0),
      msg("U1", "background chatter", 1),
      msg("U1", "<@BOT> please help", 2),
      msg("U1", "unmute", 3),
      msg("U1", "background again", 4),
    ];
    const visible = applyThreadControls(messages, "BOT").map((m) => m.text);
    expect(visible).toEqual(["mute", "<@BOT> please help", "unmute", "background again"]);
  });
});

describe("gatherSlackContext", () => {
  it("excludes aside messages from gathered context", () => {
    const context = gatherSlackContext({
      threadMessages: [msg("U1", "aside secret plan", 0), msg("U1", "fix the login bug", 1)],
    });
    expect(context).not.toContain("secret plan");
    expect(context).toContain("fix the login bug");
  });

  it("redacts a pasted token from assembled context", () => {
    const context = gatherSlackContext({
      threadMessages: [msg("U1", "token is ghp_abcdefgh12345678 here", 0)],
    });
    expect(context).not.toContain("ghp_abcdefgh12345678");
    expect(context).toContain("[redacted]");
  });

  it("caps a 400-message thread at ~50 messages", () => {
    const threadMessages = Array.from({ length: 400 }, (_, i) =>
      msg("U1", `message number ${i}`, i),
    );
    const context = gatherSlackContext({ threadMessages });
    expect(context).not.toContain("message number 0");
    expect(context).toContain("message number 399");
    const lines = context.split("\n").filter((line) => line.startsWith("["));
    expect(lines.length).toBeLessThanOrEqual(50);
  });

  it("includes linked issue/PR text alongside the thread", () => {
    const context = gatherSlackContext({
      threadMessages: [msg("U1", "fix it", 0)],
      linkedTexts: ["issue #12: null pointer on /orders"],
    });
    expect(context).toContain("null pointer");
  });
});
