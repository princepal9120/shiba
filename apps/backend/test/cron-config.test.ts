import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AUTOMATION_CRON_TICK } from "../src/automations.js";

const CONFIG = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
const INDEX = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("wrangler cron triggers", () => {
  it("ships a 5-minute cron with a scheduled() handler", () => {
    expect(CONFIG).toContain('"triggers"');
    expect(CONFIG).toContain(AUTOMATION_CRON_TICK);
    expect(INDEX).toContain("async scheduled(");
  });
});
