import { describe, expect, it, vi } from "vitest";
import { publishFilesAsPullRequest } from "../src/github.js";

const SECRET = "ghp_testtoken12345678";

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function makeFetch(calls: RecordedCall[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    if (url.endsWith("/git/ref/heads/main")) {
      return json({ object: { sha: "base-sha" } });
    }
    if (url.endsWith("/git/commits/base-sha")) {
      return json({ tree: { sha: "base-tree" } });
    }
    if (url.endsWith("/git/blobs")) {
      return json({ sha: `blob-${calls.length}` });
    }
    if (url.endsWith("/git/trees")) {
      return json({ sha: "new-tree" });
    }
    if (url.endsWith("/git/commits")) {
      return json({ sha: "new-commit" });
    }
    if (url.endsWith("/git/refs")) {
      return json({});
    }
    if (url.endsWith("/pulls")) {
      return json({ html_url: "https://github.com/owner/repo/pull/7", number: 7 });
    }
    return json({ message: "not found" }, 404);
  });
}

describe("publishFilesAsPullRequest", () => {
  it("creates blobs, tree, commit, ref, and pull request in order", async () => {
    const calls: RecordedCall[] = [];
    const result = await publishFilesAsPullRequest(
      {
        repoUrl: "https://github.com/owner/repo",
        baseBranch: "main",
        newBranch: "shiba-ai-coworker/run-abc",
        title: "AI Coworker: fix",
        body: "details",
        files: [
          { path: "a.ts", content: "hello", encoding: "utf8" },
          { path: "img.png", content: "aGVsbG8=", encoding: "base64" },
        ],
        token: SECRET,
        message: "AI Coworker: fix",
      },
      { fetchImpl: makeFetch(calls) },
    );
    expect(result).toEqual({
      branch: "shiba-ai-coworker/run-abc",
      commitSha: "new-commit",
      pullUrl: "https://github.com/owner/repo/pull/7",
      pullNumber: 7,
    });
    const paths = calls.map((call) => new URL(call.url).pathname);
    expect(paths).toEqual([
      "/repos/owner/repo/git/ref/heads/main",
      "/repos/owner/repo/git/commits/base-sha",
      "/repos/owner/repo/git/blobs",
      "/repos/owner/repo/git/blobs",
      "/repos/owner/repo/git/trees",
      "/repos/owner/repo/git/commits",
      "/repos/owner/repo/git/refs",
      "/repos/owner/repo/pulls",
    ]);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get("Authorization")).toBe(`Bearer ${SECRET}`);
    }
    const treeCall = calls.find((call) => call.url.endsWith("/git/trees"));
    const treeBody = JSON.parse(String(treeCall?.init?.body)) as { base_tree: string; tree: unknown[] };
    expect(treeBody.base_tree).toBe("base-tree");
    expect(treeBody.tree).toHaveLength(2);
  });

  it("requires a token and files", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "a", content: "x", encoding: "utf8" }],
          token: "",
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/GITHUB_TOKEN/);
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
          newBranch: "b",
          title: "t",
          body: "b",
          files: [],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/no changed files/i);
  });

  it("refuses unsafe file paths", async () => {
    const calls: RecordedCall[] = [];
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "../escape", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: makeFetch(calls) },
      ),
    ).rejects.toThrow(/unsafe file path/);
  });

  it("redacts secrets from API error messages", async () => {
    const failing = async () =>
      new Response(JSON.stringify({ message: `bad ${SECRET}` }), { status: 422 });
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "a", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: failing as typeof fetch },
      ),
    ).rejects.toThrow(/422/);
    try {
      await publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
          newBranch: "b",
          title: "t",
          body: "b",
          files: [{ path: "a", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: failing as typeof fetch },
      );
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(SECRET);
    }
  });

  it("publishes deletions as null-content tree entries", async () => {
    const calls: RecordedCall[] = [];
    await publishFilesAsPullRequest(
      {
        repoUrl: "https://github.com/owner/repo",
        baseBranch: "main",
        newBranch: "shiba-ai-coworker/run-abc",
        title: "AI Coworker: delete",
        body: "details",
        files: [
          { path: "gone.ts", content: null, encoding: "utf8" },
          { path: "kept.ts", content: "x", encoding: "utf8" },
        ],
        token: SECRET,
        message: "AI Coworker: delete",
      },
      { fetchImpl: makeFetch(calls) },
    );
    // The deleted path needs no blob upload: only one blob call for kept.ts.
    expect(calls.filter((call) => call.url.endsWith("/git/blobs"))).toHaveLength(1);
    const treeCall = calls.find((call) => call.url.endsWith("/git/trees"));
    const body = JSON.parse(String(treeCall?.init?.body)) as {
      tree: Array<{ path: string; sha: string | null }>;
    };
    expect(body.tree).toEqual([
      { path: "gone.ts", mode: "100644", type: "blob", sha: null },
      { path: "kept.ts", mode: "100644", type: "blob", sha: "blob-3" },
    ]);
  });

  it("removes the branch when the pull request cannot be created", async () => {
    const calls: RecordedCall[] = [];
    const base = makeFetch(calls);
    const failingPulls = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/pulls")) {
        calls.push({ url, init });
        return new Response(JSON.stringify({ message: "pull creation refused" }), { status: 422 });
      }
      return base(input, init);
    });
    await expect(
      publishFilesAsPullRequest(
        {
          repoUrl: "https://github.com/owner/repo",
          baseBranch: "main",
          newBranch: "shiba-ai-coworker/run-abc",
          title: "t",
          body: "b",
          files: [{ path: "a.ts", content: "x", encoding: "utf8" }],
          token: SECRET,
          message: "m",
        },
        { fetchImpl: failingPulls as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/shiba-ai-coworker\/run-abc was removed/);
    const cleanup = calls.find(
      (call) => call.init?.method === "DELETE" && call.url.includes("/git/refs/heads/shiba-ai-coworker"),
    );
    expect(cleanup).toBeDefined();
  });
});
