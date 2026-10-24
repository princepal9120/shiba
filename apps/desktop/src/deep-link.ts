import type { DesktopViewName } from "@shiba/shared";
import { parseLoopbackCallback } from "./codex-callback.js";
import { isDesktopView } from "./launch.js";
import { githubPullRequestUrl } from "./pull-request.js";

export type DeepLink =
  | { kind: "view"; view: DesktopViewName }
  | { kind: "pull-request"; url: string }
  | { kind: "codex-callback"; callbackUrl: string };

/** `shiba://open/<view>`, `shiba://pr?url=`, `shiba://auth/codex?callback=`. Anything else is ignored. */
export function parseDeepLink(raw: string): DeepLink | null {
  if (raw.length === 0 || raw.length > 4096) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "shiba:") return null;
  if (url.hostname === "open") {
    const view = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!isDesktopView(view)) return null;
    return { kind: "view", view };
  }
  if (url.hostname === "pr") {
    const target = githubPullRequestUrl(url.searchParams.get("url") ?? "");
    return target ? { kind: "pull-request", url: target } : null;
  }
  if (url.hostname === "auth" && url.pathname === "/codex") {
    const callbackUrl = parseLoopbackCallback(url.searchParams.get("callback") ?? "");
    return callbackUrl ? { kind: "codex-callback", callbackUrl } : null;
  }
  return null;
}
