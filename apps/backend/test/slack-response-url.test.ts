import { describe, expect, it } from "vitest";
import { isSlackResponseUrl } from "../src/slack-approval.js";

describe("Slack response URL policy", () => {
  it("allows only HTTPS Slack callback URLs without credentials", () => {
    expect(isSlackResponseUrl("https://hooks.slack.com/actions/example")).toBe(true);
    expect(isSlackResponseUrl("https://hooks.slack-gov.com/actions/example")).toBe(true);
    expect(isSlackResponseUrl("https://example.com/actions/example")).toBe(false);
    expect(isSlackResponseUrl("http://hooks.slack.com/actions/example")).toBe(false);
    expect(isSlackResponseUrl("not a URL")).toBe(false);
  });
});
