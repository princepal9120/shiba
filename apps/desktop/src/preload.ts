import { contextBridge, ipcRenderer } from "electron";

// Origin comes from BrowserWindow additionalArguments, never from the page (D4).
const origin = process.argv
  .find((a) => a.startsWith("--shiba-origin="))
  ?.slice("--shiba-origin=".length);
const version =
  process.argv.find((a) => a.startsWith("--shiba-version="))?.slice("--shiba-version=".length) ??
  "";

if (origin && location.origin === origin) {
  contextBridge.exposeInMainWorld("shibaDesktop", {
    version,
    status: () => ipcRenderer.invoke("desktop:status"),
    pair: (pairingToken: string) => ipcRenderer.invoke("desktop:pair", pairingToken),
    unpair: () => ipcRenderer.invoke("desktop:unpair"),
    onStatus: (listener: (status: unknown) => void) => {
      const handler = (_e: unknown, status: unknown) => listener(status);
      ipcRenderer.on("desktop:status-changed", handler);
      return () => {
        ipcRenderer.removeListener("desktop:status-changed", handler);
      };
    },
    receiveCodexCallback: (authorizationUrl: string) =>
      ipcRenderer.invoke("desktop:codex-callback", authorizationUrl),
    cancelCodexCallback: (authorizationUrl: string) =>
      ipcRenderer.invoke("desktop:codex-callback-cancel", authorizationUrl),
    startClaudeLogin: () => ipcRenderer.invoke("desktop:claude-login"),
    openView: (view: string) => ipcRenderer.invoke("desktop:open-view", view),
    openPullRequest: (url: string) => ipcRenderer.invoke("desktop:open-pr", url),
    showDiff: (patch: string) => ipcRenderer.invoke("desktop:show-diff", patch),
  });
} else if (location.protocol === "file:" && location.pathname.endsWith("/setup.html")) {
  // Setup page only; main re-checks the sender frame in the handler.
  contextBridge.exposeInMainWorld("shibaSetup", {
    setUrl: (url: string) => ipcRenderer.invoke("desktop:set-url", url),
  });
}
