import { describe, expect, it, vi } from "vitest";
import { handleSlackEvent, type SlackMentionDeps } from "../src/slack-mention.js";
import type { SlackEventCallbackBody } from "../src/slack-events.js";

const REPO = "https://github.com/owner/repo";
const THREAD = "slack:T1:C1:1758217392.000100";

type QueueRun = NonNullable<SlackMentionDeps["queueRun"]>;
type PostMessage = NonNullable<SlackMentionDeps["postMessage"]>;

function mention(overrides: Record<string, unknown> = {}): SlackEventCallbackBody {
  return {
    type: "event_callback",
    event_id: "Ev1",
    team_id: "T1",
    event: {
      type: "app_mention",
      user: "U1",
      channel: "C1",
      ts: "1758217392.000100",
      text: `<@U0> fix the tests ${REPO}`,
      ...overrides,
    },
  };
}

function env(overrides: Record<string, unknown> = {}) {
  return { SLACK_BOT_TOKEN: "xoxb-test", ...overrides } as never;
}

describe("slack mention dispatch", () => {
  it("queues a run and posts an approval card when a GitHub URL is in the mention", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(mention(), env(), {
      queueRun,
      postMessage,
      fetchThread: async () => [],
    });
    expect(queueRun).toHaveBeenCalledOnce();
    const queued = queueRun.mock.calls.at(0)?.at(0);
    expect(queued).toMatchObject({ threadKey: THREAD, repoUrl: REPO });
    expect(postMessage).toHaveBeenCalledOnce();
    const posted = postMessage.mock.calls.at(0)?.at(0);
    expect(posted?.blocks).toBeDefined();
    // Coworker voice: short repo name in the text, full URL on the card.
    expect(posted?.text).toContain("owner/repo");
    expect(JSON.stringify(posted?.blocks)).toContain(REPO);
  });

  it("uses SLACK_CHANNEL_REPOS when the mention has no URL", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(
      mention({ text: "<@U0> fix this" }),
      env({ SLACK_CHANNEL_REPOS: JSON.stringify({ C1: REPO }) }),
      { queueRun, postMessage, fetchThread: async () => [] },
    );
    expect(queueRun).toHaveBeenCalledOnce();
    expect(queueRun.mock.calls.at(0)?.at(0)?.repoUrl).toBe(REPO);
  });

  it("asks in-thread and starts no run when the repo cannot be resolved", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(mention({ text: "<@U0> fix this" }), env(), {
      queueRun,
      postMessage,
      fetchThread: async () => [],
    });
    expect(queueRun).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledOnce();
    const asked = postMessage.mock.calls.at(0)?.at(0);
    expect(asked?.text).toMatch(/which repo/i);
    expect(asked?.blocks).toBeUndefined();
  });

  it("starts no run and posts nothing when SLACK_BOT_TOKEN is empty", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(mention(), env({ SLACK_BOT_TOKEN: "" }), {
      queueRun,
      fetchThread: async () => [],
    });
    expect(queueRun).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("ignores non-mention events", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    await handleSlackEvent(
      { type: "event_callback", event_id: "Ev2", event: { type: "message" } },
      env(),
      { queueRun, postMessage: async () => {} },
    );
    expect(queueRun).not.toHaveBeenCalled();
  });
});

import {
  SLACK_INTENT_TYPES,
  classifySlackMentionIntent,
  intentHint,
  type SlackMentionIntentResult,
} from "../src/slack-mention.js";

describe("classifySlackMentionIntent (TypeSafe Choice — T14 augmentation)", () => {
  function choiceResponse(choice: string, probabilities?: Record<string, number>): Response {
    const probs = probabilities ?? { [choice]: 0.85 };
    return new Response(
      JSON.stringify({
        answers: { intent: { type: "choice", choice, probabilities: probs } },
      }),
      { status: 200 },
    );
  }

  it("returns null when apiKey is absent", async () => {
    const result = await classifySlackMentionIntent("", "fix the login bug", "bug thread");
    expect(result).toBeNull();
  });

  it("returns null when apiKey is whitespace-only", async () => {
    const result = await classifySlackMentionIntent("   ", "fix the login bug", "bug thread");
    expect(result).toBeNull();
  });

  it("returns null when mentionText is empty", async () => {
    const fetchImpl = async () => choiceResponse("fix");
    const result = await classifySlackMentionIntent("ts-key", "", "context", fetchImpl);
    expect(result).toBeNull();
  });

  it("classifies a bug fix request as fix", async () => {
    const result = await classifySlackMentionIntent(
      "ts-key",
      "fix the 500 on /orders",
      "",
      async () => choiceResponse("fix", { fix: 0.92, implement: 0.04, explain: 0.02, other: 0.02 }),
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("fix");
    expect(result!.probability).toBeCloseTo(0.92, 5);
  });

  it("classifies a feature request as implement", async () => {
    const result = await classifySlackMentionIntent(
      "ts-key",
      "add a dark mode toggle",
      "",
      async () => choiceResponse("implement", { fix: 0.05, implement: 0.88, explain: 0.04, other: 0.03 }),
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("implement");
  });

  it("classifies an explanation request as explain", async () => {
    const result = await classifySlackMentionIntent(
      "ts-key",
      "explain how the auth middleware works",
      "",
      async () => choiceResponse("explain"),
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("explain");
  });

  it("maps unknown choice values to other", async () => {
    const result = await classifySlackMentionIntent(
      "ts-key",
      "run the benchmarks",
      "",
      async () => choiceResponse("unknown-future-label"),
    );
    expect(result).not.toBeNull();
    expect(result!.intent).toBe("other");
  });

  it("returns null on HTTP error (fail open — does not block runs)", async () => {
    const result = await classifySlackMentionIntent(
      "ts-key",
      "fix tests",
      "",
      async () => new Response("error", { status: 500 }),
    );
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    const result = await classifySlackMentionIntent(
      "ts-key",
      "fix tests",
      "",
      async () => { throw new Error("network down"); },
    );
    expect(result).toBeNull();
  });

  it("returns null when choice field is missing", async () => {
    const bad = new Response(JSON.stringify({ answers: { intent: { type: "choice" } } }), { status: 200 });
    const result = await classifySlackMentionIntent("ts-key", "fix tests", "", async () => bad);
    expect(result).toBeNull();
  });

  it("sends the correct TypeSafe Choice request shape", async () => {
    let captured: RequestInit | undefined;
    const captureFetch: typeof fetch = async (_url, init) => {
      captured = init;
      return choiceResponse("fix");
    };
    await classifySlackMentionIntent("ts-key", "fix the login bug", "thread context", captureFetch);
    const sent = JSON.parse(captured?.body as string);
    expect(sent.model).toBe("jev-latest");
    expect(sent.state).toEqual({ mention: "fix the login bug", thread: "thread context" });
    expect(sent.questions.intent.type).toBe("choice");
    const criteria = sent.questions.intent.criteria;
    expect(criteria).toHaveProperty("fix");
    expect(criteria).toHaveProperty("implement");
    expect(criteria).toHaveProperty("explain");
    expect(criteria).toHaveProperty("other");
  });

  it("covers all SLACK_INTENT_TYPES values", () => {
    expect(SLACK_INTENT_TYPES).toContain("fix");
    expect(SLACK_INTENT_TYPES).toContain("implement");
    expect(SLACK_INTENT_TYPES).toContain("explain");
    expect(SLACK_INTENT_TYPES).toContain("other");
  });
});

describe("intentHint", () => {
  it("returns a hint for fix intent", () => {
    const r: SlackMentionIntentResult = { intent: "fix", probability: 0.9 };
    expect(intentHint(r)).toContain("fix");
  });

  it("returns a hint for implement intent", () => {
    const r: SlackMentionIntentResult = { intent: "implement", probability: 0.8 };
    expect(intentHint(r)).toContain("implement");
  });

  it("returns a hint for explain intent", () => {
    const r: SlackMentionIntentResult = { intent: "explain", probability: 0.7 };
    expect(intentHint(r)).toContain("explanation");
  });

  it("returns empty string for other intent", () => {
    const r: SlackMentionIntentResult = { intent: "other", probability: 0.5 };
    expect(intentHint(r)).toBe("");
  });

  it("returns empty string when classification is null", () => {
    expect(intentHint(null)).toBe("");
  });
});


describe("classifySlackMentionIntent wired into handleSlackEvent", () => {
  it("prepends intent hint to task when TYPESAFE_API_KEY is set and classification succeeds", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_intent" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    const typeSafeFetch: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          answers: {
            intent: {
              type: "choice",
              choice: "fix",
              probabilities: { fix: 0.92, implement: 0.04, explain: 0.02, other: 0.02 },
            },
          },
        }),
        { status: 200 },
      );
    await handleSlackEvent(
      mention({ text: `<@U0> the login is broken ${REPO}` }),
      env({ TYPESAFE_API_KEY: "ts-key" }),
      { queueRun, postMessage, fetchThread: async () => [], typeSafeFetch },
    );
    expect(queueRun).toHaveBeenCalledOnce();
    const queued = queueRun.mock.calls.at(0)?.at(0);
    // task should start with the intent hint sentence
    expect(queued?.task).toMatch(/fix a bug|broken behaviour/i);
  });

  it("sends task unchanged when TYPESAFE_API_KEY is absent", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_nohint" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(
      mention({ text: `<@U0> fix the login ${REPO}` }),
      env({ TYPESAFE_API_KEY: undefined }),
      { queueRun, postMessage, fetchThread: async () => [] },
    );
    expect(queueRun).toHaveBeenCalledOnce();
    const queued = queueRun.mock.calls.at(0)?.at(0);
    // no hint prepended
    expect(queued?.task).not.toMatch(/The user wants you/);
  });

  it("sends task unchanged when classification fails (fail-open)", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_fail" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    // env has key but fetch throws
    await handleSlackEvent(
      mention({ text: `<@U0> fix login ${REPO}` }),
      env({ TYPESAFE_API_KEY: "ts-key" }),
      { queueRun, postMessage, fetchThread: async () => [] },
    );
    // still queued despite classification failure
    expect(queueRun).toHaveBeenCalledOnce();
  });
});


describe("coworker voice + harness on the Slack path", () => {
  it("queues a claude-code run by default and acks like a coworker", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(mention(), env(), {
      queueRun,
      postMessage,
      fetchThread: async () => [],
    });
    const queued = queueRun.mock.calls.at(0)?.at(0);
    expect(queued?.harness).toBe("claude-code");
    const posted = postMessage.mock.calls.at(0)?.at(0);
    expect(posted?.text).toContain("on it");
    expect(posted?.text).toContain("claude code");
    expect(JSON.stringify(posted?.blocks)).toContain("claude-code");
  });

  it("prefers SLACK_AGENT_HARNESS, then AGENT_HARNESS, then claude-code", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_1" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    for (const [envVars, expected] of [
      [{ SLACK_AGENT_HARNESS: "codex", AGENT_HARNESS: "opencode" }, "codex"],
      [{ AGENT_HARNESS: "opencode" }, "opencode"],
      [{}, "claude-code"],
    ] as const) {
      queueRun.mockClear();
      await handleSlackEvent(mention(), env(envVars), {
        queueRun,
        postMessage,
        fetchThread: async () => [],
      });
      expect(queueRun.mock.calls.at(0)?.at(0)?.harness).toBe(expected);
    }
  });
});

describe("slack DM dispatch", () => {
  function dm(overrides: Record<string, unknown> = {}): SlackEventCallbackBody {
    return {
      type: "event_callback",
      event_id: "EvDm",
      team_id: "T1",
      event: {
        type: "message",
        channel_type: "im",
        user: "U9",
        channel: "D1",
        ts: "1758217400.000200",
        text: `fix the tests ${REPO}`,
        ...overrides,
      },
    };
  }

  it("treats a DM like a mention: coworker ack + queued claude run", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_dm" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(dm(), env(), {
      queueRun,
      postMessage,
      fetchThread: async () => [],
    });
    expect(queueRun).toHaveBeenCalledOnce();
    const queued = queueRun.mock.calls.at(0)?.at(0);
    expect(queued).toMatchObject({ repoUrl: REPO, userId: "U9", harness: "claude-code" });
    expect(queued?.threadKey).toBe("slack:T1:D1:1758217400.000200");
    const posted = postMessage.mock.calls.at(0)?.at(0);
    expect(posted?.text).toContain("on it");
    expect(posted?.blocks).toBeDefined();
  });

  it("ignores bot echoes and channel messages", async () => {
    const queueRun = vi.fn<QueueRun>(async () => ({ approvalId: "appr_x" }));
    const postMessage = vi.fn<PostMessage>(async () => {});
    await handleSlackEvent(dm({ bot_id: "B1" }), env(), { queueRun, postMessage, fetchThread: async () => [] });
    await handleSlackEvent(dm({ channel_type: "channel" }), env(), { queueRun, postMessage, fetchThread: async () => [] });
    await handleSlackEvent(dm({ subtype: "message_changed" }), env(), { queueRun, postMessage, fetchThread: async () => [] });
    expect(queueRun).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
