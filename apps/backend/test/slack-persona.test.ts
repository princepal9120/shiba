import { describe, expect, it, vi } from "vitest";
import {
  SLACK_COWORKER_VOICE,
  SlackProgressReporter,
  agentPhrase,
  describeHarness,
  shortRepoName,
  slackAck,
  slackAskForRepo,
  slackAskForTask,
  slackProgressText,
  slackQueueFailed,
  slackRunCancelled,
  slackRunCompleted,
  slackRunFailed,
  slackRunStarted,
} from "../src/slack-persona.js";
import { extractPullRequestUrl } from "../src/transcript.js";

const REPO = "https://github.com/princepal9120/shiba";

function everyMessage(): string[] {
  return [
    slackAskForRepo(),
    slackAskForTask(),
    slackAck({ repoUrl: REPO, harness: "claude-code" }),
    slackQueueFailed(),
    slackRunStarted({ repoUrl: REPO, baseBranch: "main", harness: "claude-code" }),
    slackRunCompleted({ repoUrl: REPO, summary: "fixed the login bug", changedFiles: 3, pullUrl: "https://github.com/o/r/pull/1" }),
    slackRunFailed({ repoUrl: REPO, userMessage: "The coding agent exited with an error.", detail: "exit 1" }),
    slackRunCancelled({ repoUrl: REPO }),
    slackProgressText({ phase: "code", message: "editing src/index.ts" }),
  ];
}

describe("coworker voice contract", () => {
  it("documents the voice the helpers implement", () => {
    expect(SLACK_COWORKER_VOICE).toContain("coworker");
    expect(SLACK_COWORKER_VOICE).toContain("first-person");
  });

  it("never emits corporate bot boilerplate or AI disclaimers", () => {
    for (const text of everyMessage()) {
      expect(text).not.toMatch(/request received|being processed|as an ai|language model|i cannot|ticket/i);
    }
  });

  it("reads like a teammate checking in", () => {
    expect(slackAck({ repoUrl: REPO, harness: "claude-code" })).toContain("on it");
    expect(slackRunStarted({ repoUrl: REPO, baseBranch: "main", harness: "claude-code" })).toContain("on it");
    expect(slackRunCompleted({ repoUrl: REPO, summary: "done things" })).toContain("done");
  });
});

describe("shortRepoName", () => {
  it("shortens a github URL to owner/repo", () => {
    expect(shortRepoName(REPO)).toBe("princepal9120/shiba");
    expect(shortRepoName("https://github.com/o/r.git")).toBe("o/r");
  });

  it("falls back to the raw value for non-github input", () => {
    expect(shortRepoName("not a url")).toBe("not a url");
  });
});

describe("describeHarness / agentPhrase", () => {
  it("names the coding agent like a coworker would", () => {
    expect(describeHarness("claude-code")).toBe("claude code");
    expect(describeHarness("opencode")).toBe("opencode");
    expect(describeHarness(undefined)).toBe("the coding agent");
  });

  it("inflects the article", () => {
    expect(agentPhrase("claude-code")).toBe("a claude code");
    expect(agentPhrase("opencode")).toBe("an opencode");
  });
});

describe("message helpers", () => {
  it("ack names the repo and the agent and points at the card", () => {
    const text = slackAck({ repoUrl: REPO, harness: "claude-code" });
    expect(text).toContain("princepal9120/shiba");
    expect(text).toContain("claude code");
    expect(text).toMatch(/approve/i);
  });

  it("completion post carries summary, file count, and the PR link", () => {
    const text = slackRunCompleted({
      repoUrl: REPO,
      summary: "rewrote the auth flow",
      changedFiles: 4,
      pullUrl: "https://github.com/o/r/pull/9",
    });
    expect(text).toContain("rewrote the auth flow");
    expect(text).toContain("4 files changed");
    expect(text).toContain("https://github.com/o/r/pull/9");
  });

  it("failure post explains plainly what broke and what it saw", () => {
    const text = slackRunFailed({
      repoUrl: REPO,
      userMessage: "The coding agent hit a rate limit.",
      detail: "anthropic 429: too many requests",
    });
    expect(text).toContain("didn't land");
    expect(text).toContain("rate limit");
    expect(text).toContain("429");
  });

  it("unknown outcomes say the run's end state is uncertain", () => {
    const text = slackRunFailed({ repoUrl: REPO, userMessage: "Outcome unknown.", unknown: true });
    expect(text).toContain("not sure");
  });

  it("cancel keeps the cancelled keyword for the audit trail", () => {
    expect(slackRunCancelled({ repoUrl: REPO })).toContain("cancelled");
  });

  it("bounds long summaries so a giant diff can't blow up the post", () => {
    const text = slackRunCompleted({ repoUrl: REPO, summary: "x".repeat(10_000) });
    expect(text.length).toBeLessThanOrEqual(3000);
  });
});

describe("slackProgressText", () => {
  it("phrases each phase like a status update, not a log line", () => {
    expect(slackProgressText({ phase: "clone", message: "Cloning repo" })).toBe("cloning the repo");
    expect(slackProgressText({ phase: "configure", message: "Writing config" })).toBe("setting up the workspace");
    expect(slackProgressText({ phase: "collect", message: "Done: 3 files" })).toContain("wrapping up");
    expect(slackProgressText({ phase: "code", message: "editing files" })).toContain("still on it");
  });
});

describe("SlackProgressReporter", () => {
  it("posts the first event and every phase transition", async () => {
    const post = vi.fn(async () => {});
    const reporter = new SlackProgressReporter(post);
    await reporter.onEvent({ phase: "clone", message: "Cloning" });
    await reporter.onEvent({ phase: "clone", message: "Still cloning" });
    await reporter.onEvent({ phase: "code", message: "Running" });
    await reporter.onEvent({ phase: "collect", message: "Done" });
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("sends an occasional heartbeat during long code phases", async () => {
    const post = vi.fn(async (_text: string) => {});
    const reporter = new SlackProgressReporter(post);
    for (let i = 0; i < 21; i++) {
      await reporter.onEvent({ phase: "code", message: `event ${i}` });
    }
    // First event + every 10th code event.
    expect(post).toHaveBeenCalledTimes(3);
    expect(post.mock.calls.at(-1)?.[0]).toContain("still on it");
  });

  it("caps total posts", async () => {
    const post = vi.fn(async () => {});
    const reporter = new SlackProgressReporter(post, 2);
    await reporter.onEvent({ phase: "clone", message: "a" });
    await reporter.onEvent({ phase: "code", message: "b" });
    await reporter.onEvent({ phase: "collect", message: "c" });
    expect(post).toHaveBeenCalledTimes(2);
  });

  it("swallows post failures so a Slack outage can't fail the run", async () => {
    const post = vi.fn(async () => {
      throw new Error("slack down");
    });
    const reporter = new SlackProgressReporter(post);
    await expect(reporter.onEvent({ phase: "clone", message: "a" })).resolves.toBeUndefined();
  });
});

describe("extractPullRequestUrl", () => {
  it("reads the PR link back out of a rendered transcript", () => {
    const output = "[code] done\nPull request: https://github.com/o/r/pull/12\nAI_INTERN_CODING_RESULT_JSON\n{}";
    expect(extractPullRequestUrl(output)).toBe("https://github.com/o/r/pull/12");
  });

  it("returns null when no PR was published", () => {
    expect(extractPullRequestUrl("Task: x\nChanged files: a.ts")).toBeNull();
  });
});
