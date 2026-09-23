import { describe, expect, it } from "vitest";
import {
  authorizeAutomationRun,
  automationsEnabled,
  collectDueSchedules,
  createAutomation,
  evaluateRunWhen,
  evaluateRunWhenTypeSafe,
  isScheduleDue,
  matchAutomationEvent,
  matchGitHubTrigger,
  matchSlackTrigger,
  parseAutomationWebhookPath,
  recordTrigger,
  recordSkip,
  validateCron,
  verifyWebhookSecret,
  type RunWhenAi,
} from "../src/automations.js";

const REPO = "https://github.com/owner/repo";

function githubAutomation() {
  return createAutomation({
    id: "auto-github",
    prompt: "Fix failing CI",
    repoUrl: REPO,
    triggers: [
      {
        kind: "github",
        events: ["pull_request:opened", "push"],
        repos: ["owner/repo"],
        branches: ["main"],
        authors: ["alice"],
      },
    ],
  }).automation;
}

describe("schedule triggers", () => {
  it("accepts a 5-minute cron and rejects sub-5-minute crons", () => {
    expect(validateCron("*/5 * * * *")).toBe(true);
    expect(validateCron("0 * * * *")).toBe(true);
    expect(validateCron("* * * * *")).toBe(false);
    expect(validateCron("*/1 * * * *")).toBe(false);
    expect(validateCron("*/2 * * * *")).toBe(false);
    expect(validateCron("not-a-cron")).toBe(false);
  });

  it("fires once per matching bucket and coalesces missed occurrences into one run", () => {
    // 2026-09-17 12:00:30 UTC — minute 0 matches */5.
    const now = Date.UTC(2026, 8, 17, 12, 0, 30);
    // Missed several ticks while the worker was down: still exactly one run.
    expect(isScheduleDue("*/5 * * * *", now, now - 60 * 60 * 1000)).toBe(true);
    // The tick fired a moment after minute 0: the occurrence is still in window.
    expect(isScheduleDue("*/5 * * * *", now + 45 * 1000, undefined)).toBe(true);
    // No occurrence anywhere in the window: never fires.
    expect(isScheduleDue("0 3 * * 1", Date.UTC(2026, 8, 17, 12, 0, 30), undefined)).toBe(false);
    // Already fired in this bucket: coalesced, no backlog run.
    const fired = recordTrigger(
      createAutomation({
        id: "auto-cron",
        prompt: "Nightly review",
        repoUrl: REPO,
        triggers: [{ kind: "schedule", cron: "*/5 * * * *" }],
      }).automation,
      now,
    );
    expect(fired.runCount).toBe(1);
    expect(fired.lastTriggeredAt).toBe(now);
    const later = Date.UTC(2026, 8, 17, 12, 5, 0);
    expect(isScheduleDue("*/5 * * * *", later, fired.lastTriggeredAt)).toBe(true);
    // Same minute, already fired: coalesced.
    expect(isScheduleDue("*/5 * * * *", now + 1000, fired.lastTriggeredAt)).toBe(false);
  });

  it("collects only due schedules for the scheduled() fan-out", () => {
    const now = Date.UTC(2026, 8, 17, 12, 0, 30);
    const due = createAutomation({
      id: "due",
      prompt: "Due task",
      repoUrl: REPO,
      triggers: [{ kind: "schedule", cron: "*/5 * * * *" }],
    }).automation;
    const idle = createAutomation({
      id: "idle",
      prompt: "Disabled task",
      repoUrl: REPO,
      enabled: false,
      triggers: [{ kind: "schedule", cron: "*/5 * * * *" }],
    }).automation;
    expect(collectDueSchedules([due, idle], now).map((a) => a.id)).toEqual(["due"]);
  });
});

describe("GitHub triggers", () => {
  it("matches PR opened on the allowed repo, branch, and author", () => {
    const trigger = githubAutomation().triggers[0];
    expect(trigger?.kind).toBe("github");
    if (trigger?.kind !== "github") throw new Error("expected github trigger");
    expect(
      matchGitHubTrigger(trigger, {
        event: "pull_request",
        action: "opened",
        repo: "owner/repo",
        branch: "main",
        author: "alice",
      }),
    ).toBe(true);
  });

  it("rejects wrong repo, branch, author, or action", () => {
    const trigger = githubAutomation().triggers[0];
    if (trigger?.kind !== "github") throw new Error("expected github trigger");
    expect(
      matchGitHubTrigger(trigger, {
        event: "pull_request",
        action: "opened",
        repo: "owner/other",
        branch: "main",
        author: "alice",
      }),
    ).toBe(false);
    expect(
      matchGitHubTrigger(trigger, {
        event: "pull_request",
        action: "opened",
        repo: "owner/repo",
        branch: "feature",
        author: "alice",
      }),
    ).toBe(false);
    expect(
      matchGitHubTrigger(trigger, {
        event: "pull_request",
        action: "closed",
        repo: "owner/repo",
        branch: "main",
        author: "alice",
      }),
    ).toBe(false);
  });

  it("filters labels when the trigger requires them", () => {
    const { automation } = createAutomation({
      id: "auto-labels",
      prompt: "Triage bugs",
      repoUrl: REPO,
      triggers: [{ kind: "github", events: ["issues:opened"], labels: ["bug"] }],
    });
    const trigger = automation.triggers[0];
    if (trigger?.kind !== "github") throw new Error("expected github trigger");
    expect(
      matchGitHubTrigger(trigger, { event: "issues", action: "opened", labels: ["bug", "p1"] }),
    ).toBe(true);
    expect(matchGitHubTrigger(trigger, { event: "issues", action: "opened", labels: ["docs"] })).toBe(
      false,
    );
  });
});

describe("Slack triggers", () => {
  it("matches channel, author, and text conditions", () => {
    const { automation } = createAutomation({
      id: "auto-slack",
      prompt: "Handle incident",
      repoUrl: REPO,
      triggers: [
        { kind: "slack", channels: ["C123"], authors: ["U456"], textContains: ["fix this"] },
      ],
    });
    const trigger = automation.triggers[0];
    if (trigger?.kind !== "slack") throw new Error("expected slack trigger");
    expect(
      matchSlackTrigger(trigger, { channel: "C123", author: "U456", text: "@shiba-ai-coworker fix this now" }),
    ).toBe(true);
    expect(
      matchSlackTrigger(trigger, { channel: "C999", author: "U456", text: "@shiba-ai-coworker fix this now" }),
    ).toBe(false);
    expect(
      matchSlackTrigger(trigger, { channel: "C123", author: "U456", text: "hello there" }),
    ).toBe(false);
  });
});

describe("webhook triggers", () => {
  it("returns the per-automation secret once on create and verifies it", () => {
    const { automation, webhookSecret } = createAutomation({
      id: "auto-hook",
      prompt: "Deploy on demand",
      repoUrl: REPO,
      triggers: [{ kind: "webhook" }],
    });
    expect(typeof webhookSecret).toBe("string");
    expect(webhookSecret!.length).toBeGreaterThanOrEqual(32);
    expect(verifyWebhookSecret(automation, webhookSecret!)).toBe(true);
    expect(verifyWebhookSecret(automation, "wrong-secret")).toBe(false);
    // No webhook trigger means no secret is ever issued.
    expect(createAutomation({ id: "x", prompt: "p", repoUrl: REPO, triggers: [{ kind: "manual" }] }).webhookSecret).toBeNull();
  });

  it("dispatches POST /api/automations/{id}/trigger only with the right secret", () => {
    const { automation, webhookSecret } = createAutomation({
      id: "auto-hook",
      prompt: "Deploy on demand",
      repoUrl: REPO,
      triggers: [{ kind: "webhook" }],
    });
    expect(parseAutomationWebhookPath("/api/automations/auto-hook/trigger")).toBe("auto-hook");
    expect(parseAutomationWebhookPath("/api/automations/auto-hook")).toBeNull();
    expect(
      matchAutomationEvent(automation, { kind: "webhook", secret: webhookSecret! }),
    ).not.toBeNull();
    expect(matchAutomationEvent(automation, { kind: "webhook", secret: "nope" })).toBeNull();
  });
});

describe("on demand and gating", () => {
  it("fires manual triggers while enabled and never while disabled", () => {
    const { automation } = createAutomation({
      id: "auto-manual",
      prompt: "Run now",
      repoUrl: REPO,
      triggers: [{ kind: "manual" }],
    });
    expect(matchAutomationEvent(automation, { kind: "manual" })).not.toBeNull();
    const disabled = { ...automation, enabled: false };
    expect(matchAutomationEvent(disabled, { kind: "manual" })).toBeNull();
    expect(
      matchAutomationEvent(disabled, {
        kind: "github",
        event: "push",
        repo: "owner/repo",
      }),
    ).toBeNull();
  });

  it("records trigger runs with runCount and timestamp", () => {
    const { automation } = createAutomation({
      id: "auto-manual",
      prompt: "Run now",
      repoUrl: REPO,
      triggers: [{ kind: "manual" }],
    });
    const once = recordTrigger(automation, 1000);
    const twice = recordTrigger(once, 2000);
    expect(twice.runCount).toBe(2);
    expect(twice.lastTriggeredAt).toBe(2000);
  });
});

function manualAutomation(overrides: Record<string, unknown> = {}) {
  const { automation } = createAutomation({
    id: "auto-safety",
    prompt: "Fix it",
    repoUrl: REPO,
    triggers: [{ kind: "manual" }],
  });
  return { ...automation, ...overrides };
}

function stubAi(answer: unknown, fail = false): RunWhenAi {
  return { run: async () => { if (fail) throw new Error("model exploded"); return answer; } };
}

const MODEL = "@cf/meta/llama-3.1-8b-instruct";

describe("run_when gate (T19)", () => {
  it("runs when the condition clearly holds", async () => {
    const verdict = await evaluateRunWhen(stubAi({ response: "YES" }), MODEL, "it is a bug report", "500s on /orders");
    expect(verdict.run).toBe(true);
    expect(verdict.reason).toContain("bug report");
  });

  it("skips a non-matching event and carries the reason", async () => {
    const verdict = await evaluateRunWhen(stubAi({ response: "NO" }), MODEL, "it is a bug report", "weekly newsletter");
    expect(verdict.run).toBe(false);
    expect(verdict.reason).toContain("did not match");
  });

  it("fails closed when the model errors", async () => {
    const verdict = await evaluateRunWhen(stubAi(null, true), MODEL, "it is a bug report", "anything");
    expect(verdict.run).toBe(false);
    expect(verdict.reason).toContain("failed closed");
    expect(verdict.reason).toContain("model exploded");
  });

  it.each([{ response: "" }, { response: "maybe, it depends" }, {}, null])(
    "fails closed on an empty or unparseable answer (%j)",
    async (answer) => {
      const verdict = await evaluateRunWhen(stubAi(answer), MODEL, "cond", "event");
      expect(verdict.run).toBe(false);
      expect(verdict.reason).toContain("failed closed");
    },
  );

  it("records a skip so the reason is never silent", () => {
    const skipped = recordSkip(manualAutomation(), "run_when did not match", 4242);
    expect(skipped.lastSkip).toEqual({ at: 4242, reason: "run_when did not match" });
  });

  it("uses TypeSafe Noul when a key is set and noul is high", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ answers: { match: { type: "noul", noul: 0.91 } } }), { status: 200 });
    const ai = stubAi({ response: "NO" });
    const verdict = await evaluateRunWhen(ai, MODEL, "it is a bug report", "500s", "ts-key", fetchImpl);
    expect(verdict.run).toBe(true);
  });

  it("fails closed on TypeSafe noul below threshold", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ answers: { match: { type: "noul", noul: 0.4 } } }), { status: 200 });
    const verdict = await evaluateRunWhenTypeSafe("ts-key", "bug", "newsletter", fetchImpl);
    expect(verdict.run).toBe(false);
    expect(verdict.reason).toContain("did not match");
  });

  it("fails closed on TypeSafe HTTP or parse errors", async () => {
    const http = await evaluateRunWhenTypeSafe("ts-key", "bug", "ev", async () => new Response("no", { status: 500 }));
    expect(http.run).toBe(false);
    expect(http.reason).toContain("failed closed");
    const bad = await evaluateRunWhenTypeSafe("ts-key", "bug", "ev", async () =>
      new Response(JSON.stringify({ answers: {} }), { status: 200 }),
    );
    expect(bad.run).toBe(false);
    expect(bad.reason).toContain("no noul");
  });
});

describe("automation safety (T20)", () => {
  const PR_ONLY = { publishPullRequest: true };

  it("requires approval by default — an automation schedules work, it does not authorize it", () => {
    const auth = authorizeAutomationRun(manualAutomation(), PR_ONLY, 0);
    expect(auth.allowed).toBe(true);
    expect(auth.requiresApproval).toBe(true);
  });

  it("grants unattended only for a PR-only run on an allowlisted repo", () => {
    const auth = authorizeAutomationRun(
      manualAutomation({ unattended: true, unattendedRepos: ["owner/repo"] }),
      PR_ONLY,
      0,
    );
    expect(auth.requiresApproval).toBe(false);
  });

  it("refuses unattended mode for a repo off the allowlist", () => {
    const auth = authorizeAutomationRun(
      manualAutomation({ unattended: true, unattendedRepos: ["other/repo"] }),
      PR_ONLY,
      0,
    );
    expect(auth.requiresApproval).toBe(true);
    expect(auth.reason).toContain("not on the automation's allowlist");
  });

  it("refuses unattended mode when the run mutates more than a pull request", () => {
    const auth = authorizeAutomationRun(
      manualAutomation({ unattended: true, unattendedRepos: ["owner/repo"] }),
      { publishPullRequest: true, otherMutations: ["push:main"] },
      0,
    );
    expect(auth.requiresApproval).toBe(true);
    expect(auth.reason).toContain("pull requests only");
  });

  it("refuses run N+1 past the daily budget and says why", () => {
    let automation = manualAutomation({ dailyRunLimit: 2 });
    for (let i = 0; i < 2; i++) {
      expect(authorizeAutomationRun(automation, PR_ONLY, 1000).allowed).toBe(true);
      automation = recordTrigger(automation, 1000);
    }
    const refused = authorizeAutomationRun(automation, PR_ONLY, 1000);
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toContain("Daily run budget reached: 2/2");
  });

  it("resets the budget on the next UTC day", () => {
    let automation = manualAutomation({ dailyRunLimit: 1 });
    automation = recordTrigger(automation, 1000);
    expect(authorizeAutomationRun(automation, PR_ONLY, 1000).allowed).toBe(false);
    expect(authorizeAutomationRun(automation, PR_ONLY, 1000 + 86_400_000).allowed).toBe(true);
  });

  it("never fires a disabled automation or anything at all when the kill switch is off", () => {
    expect(authorizeAutomationRun(manualAutomation({ enabled: false }), PR_ONLY, 0).allowed).toBe(false);
    const killed = authorizeAutomationRun(manualAutomation(), PR_ONLY, 0, false);
    expect(killed.allowed).toBe(false);
    expect(killed.reason).toContain("disabled globally");
  });

  it.each([
    ["false", false], ["0", false], ["off", false], ["no", false],
    ["true", true], ["1", true], [undefined, true], ["", true],
  ])("reads AUTOMATIONS_ENABLED=%s as %s", (value, expected) => {
    expect(automationsEnabled(value as string | undefined)).toBe(expected);
  });
});
