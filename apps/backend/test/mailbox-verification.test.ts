import { describe, expect, it } from "vitest";
import {
  agentMailbox,
  DEFAULT_AGENT_MAILBOX,
  extractVerificationSignals,
} from "../src/mailbox-verification.js";

/**
 * Pure-function coverage for the verification extractor — the MCP tools
 * (`extract_otp`, `latest_verification`) have their own registry tests in
 * `mcp-email-tools.test.ts`.
 */

describe("agentMailbox", () => {
  it("defaults to the operator identity address and honors the env override", () => {
    expect(DEFAULT_AGENT_MAILBOX).toBe("dev@tryshiba.dev");
    expect(agentMailbox({})).toBe("dev@tryshiba.dev");
    expect(agentMailbox({ AGENT_MAILBOX: "" })).toBe("dev@tryshiba.dev");
    expect(agentMailbox({ AGENT_MAILBOX: "  " })).toBe("dev@tryshiba.dev");
    expect(agentMailbox({ AGENT_MAILBOX: " Runs@TryShiba.dev " })).toBe(
      "runs@tryshiba.dev",
    );
  });
});

describe("extractVerificationSignals — codes", () => {
  it("finds a labeled numeric code in body_text", () => {
    const result = extractVerificationSignals(
      "Hello! Your verification code is 482913. It expires soon.",
      null,
    );
    expect(result.code).toBe("482913");
  });

  it("finds a reversed-phrasing code", () => {
    const result = extractVerificationSignals(
      "Use 918273 — it is your sign-in code for the console.",
      null,
    );
    expect(result.code).toBe("918273");
  });

  it("finds an uppercase token code and never a lowercase prose word", () => {
    const token = extractVerificationSignals("Your code is AB12-CD34 today.", null);
    expect(token.code).toBe("AB12-CD34");
    const prose = extractVerificationSignals("The code is your friend.", null);
    expect(prose.code).toBeNull();
  });

  it("finds an unlabeled digit run only near a verification word", () => {
    const near = extractVerificationSignals(
      "Sign in to Notion with this one-time code: 664208. Do not share it.",
      null,
    );
    expect(near.code).toBe("664208");
    const far = extractVerificationSignals(
      "Order 7712 shipped. Total $54. Track at our site. Ref 88231.",
      null,
    );
    expect(far.code).toBeNull();
  });

  it("reads the code out of body_html after stripping tags", () => {
    const html = `<div><p>Hi there</p><p>Your code is <b>771204</b></p><p>Ignore the footer 2025.</p></div>`;
    const result = extractVerificationSignals(null, html);
    expect(result.code).toBe("771204");
  });

  it("prefers the labeled text hit over anything in the html", () => {
    const result = extractVerificationSignals(
      "code: 111222",
      "<p>code: 999888</p>",
    );
    expect(result.code).toBe("111222");
  });
});

describe("extractVerificationSignals — magic links", () => {
  it("flags verify/sign-in/token URLs as magic links", () => {
    const body =
      "Welcome. https://app.example.com/auth/verify?token=abc123 then https://example.com/blog";
    const result = extractVerificationSignals(body, null);
    expect(result.magic_links).toHaveLength(1);
    expect(result.magic_links[0]?.url).toBe(
      "https://app.example.com/auth/verify?token=abc123",
    );
  });

  it("keeps the anchor text and link flags on action links", () => {
    const html = `<a href="https://accounts.example.com/login?token=x9">Sign in to your account</a> <a href="https://example.com/privacy">Privacy</a>`;
    const result = extractVerificationSignals(null, html);
    expect(result.magic_links).toHaveLength(1);
    const link = result.magic_links[0];
    expect(link?.url).toBe("https://accounts.example.com/login?token=x9");
    expect(link?.anchor_text).toBe("Sign in to your account");
    expect(link?.flags).toEqual([]);
  });

  it("classifies an action anchor on an opaque URL as magic, and keeps the injected-link flag", () => {
    const html = `<a href="https://evil.example/click?id=42">Verify your email</a>`;
    const result = extractVerificationSignals(null, html);
    expect(result.magic_links).toHaveLength(1);
    const flagged = extractVerificationSignals(
      null,
      `<a href="http://10.0.0.4/verify">Verify</a>`,
    );
    expect(flagged.magic_links[0]?.flags).toContain("private_ip");
    expect(flagged.magic_links[0]?.flags).toContain("non_https");
  });

  it("dedupes the same URL across text and html", () => {
    const url = "https://app.example.com/magic?t=1";
    const result = extractVerificationSignals(
      `click ${url}`,
      `<p>or <a href="${url}">Sign in</a></p>`,
    );
    expect(result.magic_links).toHaveLength(1);
  });

  it("returns empty extraction for ordinary mail", () => {
    const result = extractVerificationSignals(
      "See you at standup. Notes: https://example.com/notes",
      null,
    );
    expect(result.code).toBeNull();
    expect(result.magic_links).toHaveLength(0);
  });
});
