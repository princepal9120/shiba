/** https://github.com/owner/repo/pull/123 with no userinfo, query, or fragment. */
export function githubPullRequestUrl(value: string): string | null {
  if (value.length === 0 || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.hostname !== "github.com") return null;
  if (!/^\/[^/]+\/[^/]+\/pull\/\d+\/?$/.test(url.pathname)) return null;
  url.search = "";
  url.hash = "";
  if (url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}
