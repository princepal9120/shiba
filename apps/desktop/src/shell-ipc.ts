import type {
  DesktopClaudeLoginResult,
  DesktopCodexCallbackResult,
  DesktopDiffResult,
  DesktopPullRequestResult,
  DesktopViewName,
} from "@shiba/shared";
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { summarizeUnifiedDiff } from "./diff-summary.js";
import { dashboardPath, isDesktopView } from "./launch.js";
import { githubPullRequestUrl } from "./pull-request.js";

export const DESKTOP_CODEX_CALLBACK_CHANNEL = "desktop:codex-callback";
export const DESKTOP_CODEX_CANCEL_CHANNEL = "desktop:codex-callback-cancel";
export const DESKTOP_CLAUDE_LOGIN_CHANNEL = "desktop:claude-login";
export const DESKTOP_OPEN_VIEW_CHANNEL = "desktop:open-view";
export const DESKTOP_OPEN_PR_CHANNEL = "desktop:open-pr";
export const DESKTOP_SHOW_DIFF_CHANNEL = "desktop:show-diff";
export const DESKTOP_DIFF_PAYLOAD_CHANNEL = "desktop:diff-payload";

export interface ShellIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  isTrustedSender(senderFrameUrl: string | undefined, configuredOrigin: string): boolean;
  getConfiguredOrigin(): string;
  /** True only for the bundled diff.html frame. */
  isDiffSender(senderFrameUrl: string | undefined): boolean;
  loadDashboardPath(pathAndQuery: string): void;
  openExternal(url: string): Promise<void> | void;
  presentDiff(patch: string): void;
  readDiffPatch(): string;
  receiveCodex(authorizationUrl: string): Promise<string>;
  cancelCodex(authorizationUrl: string): void;
  startClaudeLogin(): Promise<DesktopClaudeLoginResult>;
}

function frameUrl(event: IpcMainInvokeEvent): string | undefined {
  return event.senderFrame?.url;
}

export function registerShellIpc(deps: ShellIpcDeps): void {
  const trusted = (event: IpcMainInvokeEvent) =>
    deps.isTrustedSender(frameUrl(event), deps.getConfiguredOrigin());

  deps.ipcMain.handle(
    DESKTOP_CODEX_CALLBACK_CHANNEL,
    async (event, authorizationUrl: unknown): Promise<DesktopCodexCallbackResult> => {
      if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
      if (typeof authorizationUrl !== "string") {
        return { ok: false, error: "ChatGPT sign-in URL is not valid." };
      }
      try {
        const callbackUrl = await deps.receiveCodex(authorizationUrl);
        return { ok: true, callbackUrl };
      } catch (error) {
        const message = error instanceof Error ? error.message : "ChatGPT sign-in failed.";
        return { ok: false, error: message };
      }
    },
  );

  deps.ipcMain.handle(DESKTOP_CODEX_CANCEL_CHANNEL, (event, authorizationUrl: unknown): void => {
    if (!trusted(event) || typeof authorizationUrl !== "string") return;
    deps.cancelCodex(authorizationUrl);
  });

  deps.ipcMain.handle(
    DESKTOP_CLAUDE_LOGIN_CHANNEL,
    async (event): Promise<DesktopClaudeLoginResult> => {
      if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
      return deps.startClaudeLogin();
    },
  );

  deps.ipcMain.handle(DESKTOP_OPEN_VIEW_CHANNEL, (event, view: unknown): void => {
    if (!trusted(event) || typeof view !== "string" || !isDesktopView(view)) return;
    deps.loadDashboardPath(dashboardPath(view as DesktopViewName));
  });

  deps.ipcMain.handle(
    DESKTOP_OPEN_PR_CHANNEL,
    async (event, url: unknown): Promise<DesktopPullRequestResult> => {
      if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
      const target = typeof url === "string" ? githubPullRequestUrl(url) : null;
      if (!target)
        return { ok: false, error: "Pull request URL must be an https://github.com pull link." };
      await deps.openExternal(target);
      return { ok: true, url: target };
    },
  );

  deps.ipcMain.handle(DESKTOP_SHOW_DIFF_CHANNEL, (event, patch: unknown): DesktopDiffResult => {
    if (!trusted(event)) return { ok: false, error: "Untrusted sender." };
    if (typeof patch !== "string") return { ok: false, error: "Diff is not text." };
    const parsed = summarizeUnifiedDiff(patch);
    if (!parsed.ok) return parsed;
    deps.presentDiff(patch);
    return { ok: true, ...parsed.summary };
  });

  deps.ipcMain.handle(DESKTOP_DIFF_PAYLOAD_CHANNEL, (event): string => {
    if (!deps.isDiffSender(frameUrl(event))) return "";
    return deps.readDiffPatch();
  });
}
