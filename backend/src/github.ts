/**
 * Publish captured file contents as a pull request using only the GitHub
 * REST API from Worker code. The token travels in one Authorization header
 * and never enters the container, a clone URL, a command, the process
 * environment, logs, or UI output.
 */
import { parseGitHubRepoUrl, redactSecrets } from "./security.js";

export interface CapturedFile {
  path: string;
  /** File content: UTF-8 text, base64 for binary, or null when the file was deleted. */
  content: string | null;
  encoding: "utf8" | "base64";
}

export interface PublishRequest {
  repoUrl: string;
  baseBranch: string;
  newBranch: string;
  title: string;
  body: string;
  files: CapturedFile[];
  token: string;
  message: string;
}

export interface PublishResult {
  branch: string;
  commitSha: string;
  pullUrl: string;
  pullNumber: number;
}

export interface GitHubDeps {
  fetchImpl?: typeof fetch;
  apiBase?: string;
}

const API_BASE = "https://api.github.com";
const USER_AGENT = "ai-intern";
const API_TIMEOUT_MS = 30_000;

function authHeaders(token: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": USER_AGENT,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function describeError(status: number, bodyText: string): string {
  const snippet = redactSecrets(bodyText.slice(0, 500));
  return `GitHub API request failed with status ${status}: ${snippet}`;
}

async function api<T>(
  deps: Required<GitHubDeps>,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await deps.fetchImpl(`${deps.apiBase}${path}`, { ...init, signal: combined });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(describeError(response.status, text));
  }
  // 204 responses (e.g. ref deletion) carry no body.
  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Create blobs, a tree, a commit, a branch ref, and a pull request.
 * Throws on empty file lists and on any API failure. All failures are
 * reported with redacted messages.
 */
export async function publishFilesAsPullRequest(
  request: PublishRequest,
  deps: GitHubDeps = {},
): Promise<PublishResult> {
  const { owner, repo } = parseGitHubRepoUrl(request.repoUrl);
  if (!request.token) {
    throw new Error("Publishing a pull request requires the GITHUB_TOKEN secret.");
  }
  if (request.files.length === 0) {
    throw new Error("Nothing to publish: the coding run produced no changed files.");
  }
  const resolved: Required<GitHubDeps> = {
    fetchImpl: deps.fetchImpl ?? fetch,
    apiBase: deps.apiBase ?? API_BASE,
  };
  const headers = authHeaders(request.token);
  const json = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const ref = await api<{ object: { sha: string } }>(
    resolved,
    `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(request.baseBranch)}`,
    { headers },
  );
  const baseSha = ref.object.sha;

  const baseCommit = await api<{ tree: { sha: string } }>(resolved, `/repos/${owner}/${repo}/git/commits/${baseSha}`, {
    headers,
  });

  const treeEntries: Array<{ path: string; mode?: string; type?: string; sha: string | null }> = [];
  for (const file of request.files) {
    if (!file.path || file.path.startsWith("/") || file.path.split("/").includes("..")) {
      throw new Error(`Refusing to publish unsafe file path: ${file.path}`);
    }
    // Null content = deletion: a null-sha tree entry removes the path from the tree.
    if (file.content === null) {
      treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await api<{ sha: string }>(resolved, `/repos/${owner}/${repo}/git/blobs`, json({
      content: file.content,
      encoding: file.encoding === "base64" ? "base64" : "utf-8",
    }));
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await api<{ sha: string }>(resolved, `/repos/${owner}/${repo}/git/trees`, json({
    base_tree: baseCommit.tree.sha,
    tree: treeEntries,
  }));

  const commit = await api<{ sha: string }>(resolved, `/repos/${owner}/${repo}/git/commits`, json({
    message: request.message,
    tree: tree.sha,
    parents: [baseSha],
  }));

  await api<unknown>(resolved, `/repos/${owner}/${repo}/git/refs`, json({
    ref: `refs/heads/${request.newBranch}`,
    sha: commit.sha,
  }));

  let pull: { html_url: string; number: number };
  try {
    pull = await api<{ html_url: string; number: number }>(
      resolved,
      `/repos/${owner}/${repo}/pulls`,
      json({
        title: request.title,
        head: request.newBranch,
        base: request.baseBranch,
        body: request.body,
      }),
    );
  } catch (error) {
    // Leave no orphaned branch behind when the PR cannot be opened.
    await api<unknown>(resolved, `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(request.newBranch)}`, {
      method: "DELETE",
      headers,
    }).catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} (branch ${request.newBranch} was removed).`);
  }

  return {
    branch: request.newBranch,
    commitSha: commit.sha,
    pullUrl: pull.html_url,
    pullNumber: pull.number,
  };
}
