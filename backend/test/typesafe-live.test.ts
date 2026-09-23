/**
 * LIVE TypeSafe System One verification — the one thing mocked tests cannot prove.
 *
 * Skipped entirely unless a key is present. Provide one either way:
 *   TYPESAFE_API_KEY=tsk_... pnpm test -- typesafe-live
 * or put TYPESAFE_API_KEY=... in .dev.vars (gitignored) and run pnpm test:live.
 *
 * Exercises the three wired integrations against the real API:
 *   Noul  — the run_when gate (src/automations.ts, fail closed)
 *   Choice — Slack mention intent (src/slack-mention.ts, fail open)
 *   Score — run result quality (src/result-quality.ts, fail open)
 * The key is never printed, logged, or embedded in an assertion message.
 * This is a stateless inference call — it deploys nothing and alters nothing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRunWhenTypeSafe } from "../src/automations.js";
import { evaluateResultQuality } from "../src/result-quality.js";
import { classifySlackMentionIntent } from "../src/slack-mention.js";

function keyFromDevVars(): string | null {
  try {
    const raw = readFileSync(join(process.cwd(), "backend", ".dev.vars"), "utf8");
    const line = raw.split("\n").find((entry) => entry.startsWith("TYPESAFE_API_KEY="));
    return line ? line.slice("TYPESAFE_API_KEY=".length).trim() : null;
  } catch {
    return null;
  }
}

const KEY = process.env.TYPESAFE_API_KEY?.trim() || keyFromDevVars();

describe.skipIf(!KEY)("TypeSafe System One — LIVE", () => {
  it(
    "Noul run_when gate: a real bug report runs, a newsletter does not (fail closed both ways)",
    async () => {
      const matching = await evaluateRunWhenTypeSafe(
        KEY as string,
        "it is a bug report about a crash",
        "TypeError: cannot read properties of undefined when clicking checkout; 500s since deploy",
        fetch,
      );
      expect(matching.run, `expected a run, gate said: ${matching.reason}`).toBe(true);
      const nonMatching = await evaluateRunWhenTypeSafe(
        KEY as string,
        "it is a bug report about a crash",
        "The weekly product newsletter went out on time.",
        fetch,
      );
      expect(nonMatching.run, `expected a skip, gate said: ${nonMatching.reason}`).toBe(false);
    },
    60_000,
  );

  it(
    "Choice classifies a fix request as fix (Slack intent, fail open)",
    async () => {
      const result = await classifySlackMentionIntent(
        KEY as string,
        "<@U0> fix the login crash when clicking the submit button",
        "",
        fetch,
      );
      expect(result, "classification returned null — check the key and api.typesafe.ai status").not.toBeNull();
      expect(result?.intent).toBe("fix");
      expect(result?.probability).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "Score grades a good run summary as full or near-full success (result quality, fail open)",
    async () => {
      const quality = await evaluateResultQuality(
        KEY as string,
        "Fixed the failing checkout test by correcting a null check; all 3 tests pass now; changed 2 files, tests only.",
        fetch,
      );
      expect(quality, "quality returned null — check the key and api.typesafe.ai status").not.toBeNull();
      expect(quality?.score ?? 0).toBeGreaterThanOrEqual(2);
      expect(quality?.score ?? 4).toBeLessThanOrEqual(3);
    },
    60_000,
  );
});
