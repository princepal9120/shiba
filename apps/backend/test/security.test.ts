import { describe, expect, it } from "vitest";
import {
  boundTail,
  parseGitHubRepoUrl,
  redactSecrets,
  shellJoin,
  shellQuote,
  verifyGitHubWebhookSignature,
  InputError,
} from "../src/security.js";

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

describe("verifyGitHubWebhookSignature", () => {
  const SECRET = "whsec_test_secret";
  const PAYLOAD = '{"action":"opened"}';

  it("accepts a valid signature", async () => {
    expect(
      await verifyGitHubWebhookSignature({ secret: SECRET, payload: PAYLOAD, signature: await sign(SECRET, PAYLOAD) }),
    ).toBe(true);
  });

  it("compares the hex digest case-insensitively", async () => {
    const good = await sign(SECRET, PAYLOAD);
    expect(
      await verifyGitHubWebhookSignature({
        secret: SECRET,
        payload: PAYLOAD,
        signature: `sha256=${good.slice("sha256=".length).toUpperCase()}`,
      }),
    ).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    expect(
      await verifyGitHubWebhookSignature({ secret: SECRET, payload: PAYLOAD, signature: await sign("other", PAYLOAD) }),
    ).toBe(false);
  });

  it("rejects a tampered body", async () => {
    expect(
      await verifyGitHubWebhookSignature({
        secret: SECRET,
        payload: '{"action":"closed"}',
        signature: await sign(SECRET, PAYLOAD),
      }),
    ).toBe(false);
  });

  it("rejects a missing header, a missing prefix, and an empty secret", async () => {
    const good = await sign(SECRET, PAYLOAD);
    expect(await verifyGitHubWebhookSignature({ secret: SECRET, payload: PAYLOAD, signature: null })).toBe(false);
    expect(
      await verifyGitHubWebhookSignature({ secret: SECRET, payload: PAYLOAD, signature: good.slice("sha256=".length) }),
    ).toBe(false);
    expect(await verifyGitHubWebhookSignature({ secret: "", payload: PAYLOAD, signature: good })).toBe(false);
  });

  it("rejects a truncated digest without throwing", async () => {
    const good = await sign(SECRET, PAYLOAD);
    expect(
      await verifyGitHubWebhookSignature({ secret: SECRET, payload: PAYLOAD, signature: good.slice(0, 20) }),
    ).toBe(false);
  });
});

describe("parseGitHubRepoUrl", () => {
  it("accepts a canonical repository URL", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("accepts a .git suffix and trailing slash", () => {
    expect(parseGitHubRepoUrl("https://github.com/owner/repo.git/")).toEqual({
      owner: "owner",
      repo: "repo",
    });
  });

  it("rejects non-HTTPS URLs", () => {
    expect(() => parseGitHubRepoUrl("http://github.com/owner/repo")).toThrow();
  });

  it("rejects non-GitHub hosts", () => {
    expect(() => parseGitHubRepoUrl("https://gitlab.com/owner/repo")).toThrow();
    expect(() => parseGitHubRepoUrl("https://evilgithub.com/owner/repo")).toThrow();
    expect(() => parseGitHubRepoUrl("https://github.com.evil.com/owner/repo")).toThrow();
  });

  it("rejects embedded credentials", () => {
    expect(() => parseGitHubRepoUrl("https://user:pass@github.com/owner/repo")).toThrow();
  });

  it("rejects wrong path shapes", () => {
    expect(() => parseGitHubRepoUrl("https://github.com/owner")).toThrow();
    expect(() => parseGitHubRepoUrl("https://github.com/a/b/c")).toThrow();
    expect(() => parseGitHubRepoUrl("https://github.com/../x")).toThrow();
  });

  it("rejects non-URLs", () => {
    expect(() => parseGitHubRepoUrl("not a url")).toThrow();
    expect(() => parseGitHubRepoUrl("")).toThrow();
  });
});

describe("shellQuote", () => {
  it("quotes spaces and metacharacters", () => {
    expect(shellQuote("hello world")).toBe("'hello world'");
  });

  it("neutralizes single quotes", () => {
    const evil = `x'; echo pwned; '`;
    const quoted = shellQuote(evil);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
  });

  it("shellJoin quotes every argument", () => {
    const joined = shellJoin(["git", "clone", "--branch", "a;bad", "https://github.com/o/r"]);
    expect(joined).toBe(`'git' 'clone' '--branch' 'a;bad' 'https://github.com/o/r'`);
  });
});

describe("redactSecrets", () => {
  it("redacts GitHub tokens, bearer headers, and provider keys", () => {
    const text = "token ghp_abcdefgh12345678 and Bearer abcdefgh.1234 plus AIzaabcdefgh12345678";
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("ghp_abcdefgh");
    expect(redacted).not.toContain("AIza");
    expect(redacted).toContain("[redacted]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("hello world")).toBe("hello world");
  });
});

describe("boundTail", () => {
  it("keeps short text intact", () => {
    expect(boundTail("abc", 10)).toBe("abc");
  });

  it("truncates long text from the front with a marker", () => {
    const out = boundTail("x".repeat(100), 10);
    expect(out.endsWith("x".repeat(10))).toBe(true);
    expect(out).toContain("truncated");
  });
});

describe("error shapes", () => {
  it("ConfigError exposes a stable code", () => {
    expect(new InputError("bad").code).toBe("input_error");
  });
});
