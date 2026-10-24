import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MenuItemConstructorOptions, Rectangle } from "electron";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  powerMonitor,
  screen,
  session,
  shell,
} from "electron";
import type { ApprovalsPoller } from "./approvals-poller.js";
import { createApprovalsPoller } from "./approvals-poller.js";
import { startClaudeLogin } from "./claude-login.js";
import {
  cancelCodexCallback,
  receiveCodexCallback,
  submitCodexCallback,
} from "./codex-callback.js";
import type { Controller } from "./controller.js";
import { createController } from "./controller.js";
import { parseDeepLink } from "./deep-link.js";
import { dashboardPath, resolveConfiguredOrigin } from "./launch.js";
import type { Logger } from "./logs.js";
import { createLogger } from "./logs.js";
import {
  DEFAULT_AUTH_HOSTS,
  decideNavigation,
  isSetupSender,
  isTrustedSender,
  parseDeploymentUrl,
} from "./navigation.js";
import type { DesktopSupervisor } from "./pairing.js";
import { emitStatusChanged, registerDesktopIpc } from "./pairing.js";
import { handleDaemonMessage } from "./run-notify.js";
import type { Env } from "./shell-env.js";
import { captureShellEnv } from "./shell-env.js";
import { registerShellIpc } from "./shell-ipc.js";
import { forkDaemon, resolveDaemonPath, shouldConfirmQuit } from "./supervisor.js";
import { buildTrayMenu, createTray } from "./tray.js";
import { startUpdater } from "./updater.js";

interface DesktopConfig {
  deploymentUrl?: string;
  notifications?: boolean;
  startAtLogin?: boolean;
  authHosts?: string[];
  bounds?: Rectangle;
}

const isMac = process.platform === "darwin";
// userData/logs land in ~/Library/Application Support/<name> — the packaged
// package.json keeps the scoped name, so pin the product name (docs promise
// ~/Library/Application Support/Shiba).
app.setName("Shiba");
// Packaged, setup.html/setup.js ship in app.asar.unpacked/dist (asarUnpack in
// electron-builder.yml): file:// can't see inside app.asar on modern Electron,
// so the page is loaded from its real path on disk. Dev keeps dist/.
const SETUP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, "app.asar.unpacked", "dist")
  : __dirname;
const SETUP_FILE = path.join(SETUP_DIR, "setup.html");
const SETUP_URL = `file://${SETUP_FILE}`;
const DIFF_FILE = path.join(SETUP_DIR, "diff.html");
const DIFF_URL = `file://${DIFF_FILE}`;

let config: DesktopConfig = {};
let mainWindow: BrowserWindow | null = null;
let quitting = false;
let saveTimer: NodeJS.Timeout | undefined;
let controller: Controller | null = null;
let poller: ApprovalsPoller | null = null;
let tray: ReturnType<typeof createTray> | null = null;
let mainLog: Logger | null = null;
let daemonLog: Logger | null = null;
let shellEnv: Env = {};
let runRoot = path.join(os.homedir(), ".shiba-local");
let shutdownStarted = false;
let diffPatch = "";
let diffWindow: BrowserWindow | null = null;
const pendingLinks: string[] = [];

const log = (line: string) => mainLog?.line(line);

const configPath = () => path.join(app.getPath("userData"), "config.json");

function loadConfig(): DesktopConfig {
  try {
    return JSON.parse(fs.readFileSync(configPath(), "utf8")) as DesktopConfig;
  } catch {
    return {};
  }
}

function saveConfig(patch: Partial<DesktopConfig>): void {
  config = { ...config, ...patch };
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  const tmp = `${configPath()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

/** Dev URL override, then a saved self-hosted origin, then https://app.tryshiba.dev. */
function configuredOrigin(): string {
  return resolveConfiguredOrigin({
    packaged: app.isPackaged,
    envUrl: process.env.SHIBA_DESKTOP_URL,
    forceSetup: !app.isPackaged && process.env.SHIBA_DESKTOP_SETUP === "1",
    savedUrl: config.deploymentUrl,
    parse: parseDeploymentUrl,
  });
}

const authHosts = () => config.authHosts ?? DEFAULT_AUTH_HOSTS;

function restoredBounds(): Rectangle | undefined {
  const b = config.bounds;
  if (!b) return undefined;
  const visible = screen
    .getAllDisplays()
    .some(
      ({ workArea: w }) =>
        b.x < w.x + w.width && b.x + b.width > w.x && b.y < w.y + w.height && b.y + b.height > w.y,
    );
  return visible ? b : undefined;
}

function loadSetup(error?: string): void {
  if (!mainWindow) return;
  // loadFile resolves asar paths (packaged setup.html lives inside app.asar);
  // loadURL("file://…asar/…") hits the raw file loader and 404s. The gate
  // compares pathname only, so the query string stays equivalent.
  const params = new URLSearchParams();
  if (error) params.set("error", error);
  const origin = configuredOrigin();
  if (origin) params.set("url", origin);
  const query = params.toString();
  void mainWindow.loadURL(`${SETUP_URL}${query ? `?${query}` : ""}`);
}

function loadDashboard(): void {
  const origin = configuredOrigin();
  if (!origin) {
    loadSetup();
    return;
  }
  void mainWindow?.loadURL(`${origin}/app/`);
}

function guardNavigation(win: BrowserWindow, allowFileUrl?: string): void {
  const wc = win.webContents;
  const gate = (event: { preventDefault(): void }, url: string) => {
    if (allowFileUrl && sameFileUrl(url, allowFileUrl)) return;
    const decision = decideNavigation(url, configuredOrigin(), authHosts());
    if (decision === "allow") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  };
  wc.on("will-navigate", (event) => gate(event, event.url));
  wc.on("will-redirect", (event) => gate(event, event.url));
  wc.on("will-attach-webview", (event) => event.preventDefault());
  wc.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https:")) void shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("did-fail-load", (_e, code, description, validatedUrl, isMainFrame) => {
    // -3 = ERR_ABORTED (superseded navigation), not a real failure.
    if (!isMainFrame || code === -3) return;
    const origin = configuredOrigin();
    if (origin && validatedUrl.startsWith(origin))
      loadSetup(`Could not load ${origin}: ${description}`);
  });
}

function sameFileUrl(target: string, fileUrl: string): boolean {
  try {
    const next = new URL(target);
    const allowed = new URL(fileUrl);
    return (
      next.protocol === "file:" &&
      allowed.protocol === "file:" &&
      next.pathname === allowed.pathname
    );
  } catch {
    return false;
  }
}

function saveBoundsSoon(win: BrowserWindow): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isMinimized() && !win.isFullScreen())
      saveConfig({ bounds: win.getBounds() });
  }, 500);
}

function createWindow(): void {
  const bounds = restoredBounds();
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    ...bounds,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      // preload reads these; the page can't influence them (D4).
      additionalArguments: [
        `--shiba-origin=${configuredOrigin()}`,
        `--shiba-version=${app.getVersion()}`,
      ],
    },
  });
  mainWindow = win;
  guardNavigation(win);
  win.once("ready-to-show", () => win.show());
  // Sign-in finishes with a navigation; re-probe then instead of waiting for the 60s timer.
  win.webContents.on("did-navigate", () => {
    if (controller?.status().state === "signed-out") void controller.probe();
  });
  win.on("resize", () => saveBoundsSoon(win));
  win.on("move", () => saveBoundsSoon(win));
  win.on("close", (event) => {
    if (!win.isDestroyed()) saveConfig({ bounds: win.getBounds() });
    // macOS keeps the app alive; only an explicit quit closes the window.
    if (isMac && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });
  loadDashboard();
}

function presentDiff(patch: string): void {
  diffPatch = patch;
  if (diffWindow && !diffWindow.isDestroyed()) {
    diffWindow.show();
    void diffWindow.loadURL(DIFF_URL);
    return;
  }
  const win = new BrowserWindow({
    width: 960,
    height: 720,
    title: "Shiba diff",
    webPreferences: {
      preload: path.join(__dirname, "diff-preload.js"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  diffWindow = win;
  guardNavigation(win, DIFF_URL);
  win.on("closed", () => {
    if (diffWindow !== win) return;
    diffWindow = null;
    diffPatch = "";
  });
  void win.loadURL(DIFF_URL);
}

function handleDeepLink(raw: string): void {
  if (!mainWindow) {
    pendingLinks.push(raw);
    return;
  }
  const link = parseDeepLink(raw);
  if (!link) return;
  if (link.kind === "view") openPath(dashboardPath(link.view));
  else if (link.kind === "pull-request") void shell.openExternal(link.url);
  else submitCodexCallback(link.callbackUrl);
}

function flushDeepLinks(): void {
  for (const raw of pendingLinks.splice(0)) handleDeepLink(raw);
}

function showWindow(): void {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/** Window is rebuilt because the preload origin is fixed at creation. */
function recreateWindow(): void {
  const old = mainWindow;
  mainWindow = null;
  createWindow();
  old?.destroy();
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: "appMenu" } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        {
          label: "Change Shiba URL…",
          click: () => {
            showWindow();
            loadSetup();
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function configurePermissions(win: BrowserWindow): void {
  const allowed = (permission: string, url: string) =>
    permission === "clipboard-sanitized-write" && isTrustedSender(url, configuredOrigin());
  const ses = win.webContents.session;
  ses.setPermissionRequestHandler((wc, permission, callback) =>
    callback(allowed(permission, wc.getURL())),
  );
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin || wc?.getURL() || ""),
  );
}

const sessionFetch = (url: string, init?: RequestInit) =>
  // Timeout: a hung probe would leave the controller's probing flag set forever.
  session.defaultSession.fetch(url, {
    credentials: "include",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
    ...init,
  });

function notify(n: { title: string; body: string }, onClick: () => void): void {
  if (config.notifications === false || !Notification.isSupported()) return;
  const notification = new Notification({ title: n.title, body: n.body });
  notification.on("click", onClick);
  notification.show();
}

function openPath(pathAndQuery: string): void {
  const origin = configuredOrigin();
  if (!origin) {
    loadSetup();
    return;
  }
  showWindow();
  void mainWindow?.loadURL(`${origin}${pathAndQuery}`);
}

function buildPoller(): void {
  poller?.stop();
  const origin = configuredOrigin();
  poller = origin
    ? createApprovalsPoller({
        fetch: (url) => sessionFetch(url),
        approvalsUrl: `${origin}/api/approvals`,
        openUrl: `${origin}/app/?tab=approvals`,
        showWindow,
        loadURL: (url) => mainWindow?.loadURL(url),
        notify,
        log: (...args) => log(args.map(String).join(" ")),
      })
    : null;
}

function refreshTray(): void {
  if (!controller) return;
  tray?.update(
    buildTrayMenu(controller.status(), {
      notifications: config.notifications !== false,
      startAtLogin: config.startAtLogin !== false,
    }),
  );
}

function onStatus(status: Parameters<typeof emitStatusChanged>[1]): void {
  emitStatusChanged(mainWindow?.webContents, status);
  refreshTray();
  // The approvals poller has its own probe (§3.4), so it just retries whenever the daemon state moves.
  if (status.state !== "signed-out" && config.notifications !== false) void poller?.start();
}

/** Mirrors the desktop:unpair handler for the tray; the renderer path lives in pairing.ts. */
async function disconnectLocal(): Promise<void> {
  const origin = configuredOrigin();
  // Fall back to the on-disk config so revoke still runs when the state has
  // dropped machineId (e.g. "crashed"), unless the config is gone.
  const machineId = controller?.status().machineId ?? readLocalConfig()?.machineId;
  try {
    // Stop first: a mid-run daemon settles its claim with the token revoke is about to kill.
    await controller?.stop();
    if (machineId && origin) {
      const res = await sessionFetch(`${origin}/api/computers/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId }),
      });
      // A failed revoke leaves the token hash valid until the 7-day prune;
      // deleting the local config anyway would hide that. Mirror pairing.ts.
      if (!res.ok) {
        log(`disconnect: revoke returned ${res.status}; keeping local config`);
        return;
      }
    }
    fs.rmSync(path.join(runRoot, "config.json"), { force: true });
  } catch (error) {
    log(`disconnect failed: ${String(error)}`);
  } finally {
    // Also after a failed revoke: config is kept, so the probe restarts the daemon.
    void controller?.probe();
  }
}

async function checkForUpdates(): Promise<unknown> {
  const mod = await import("electron-updater");
  // electron-updater is CJS; under ESM interop the real exports land on
  // .default (autoUpdater isn't statically detectable as a named export).
  const resolved = (mod as unknown as { default?: typeof mod }).default ?? mod;
  const { autoUpdater } = resolved;
  return autoUpdater.checkForUpdatesAndNotify();
}

function onTraySelect(id: string): void {
  switch (id) {
    case "open":
      openPath("/app/");
      return;
    case "approvals":
      openPath("/app/?tab=approvals");
      return;
    case "connect":
      openPath("/app/?tab=remote");
      return;
    case "disconnect":
      return void disconnectLocal();
    case "retry":
      return void controller?.retry();
    case "notifications": {
      saveConfig({ notifications: config.notifications === false });
      if (config.notifications === false) poller?.stop();
      else void poller?.start();
      refreshTray();
      return;
    }
    case "start-at-login": {
      saveConfig({ startAtLogin: config.startAtLogin === false });
      applyLoginItem();
      refreshTray();
      return;
    }
    case "change-url":
      showWindow();
      loadSetup();
      return;
    case "logs":
      return void shell.openPath(path.join(app.getPath("userData"), "logs"));
    case "updates":
      return void checkForUpdates().catch((e) => log(`update check failed: ${String(e)}`));
    case "quit":
      app.quit();
      return;
  }
}

function applyLoginItem(): void {
  // openAsHidden is gone from Electron 44 types; dev runs must not register the unpackaged binary.
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: config.startAtLogin !== false });
}

function trayIconPath(): string | null {
  // assets/ ships inside app.asar via electron-builder "files"; getAppPath()
  // returns the asar root packaged and the package dir in dev. Electron's fs
  // reads asar paths transparently, so one path works in both modes.
  const base = app.getAppPath();
  const icon = path.join(base, "assets", "trayTemplate.png");
  return fs.existsSync(icon) ? icon : null;
}

const supervisorFacade: DesktopSupervisor = {
  status: () => controller?.status() ?? { state: "signed-out" },
  stop: async () => {
    await controller?.stop();
    controller?.setStatus({ state: "unpaired" });
  },
  probe: () => controller?.probe(),
  forkDaemon: (args) => {
    if (!controller) throw new Error("Shiba Desktop is still starting.");
    return controller.forkForPairing(args);
  },
};

function registerIpc(): void {
  registerDesktopIpc({
    ipcMain,
    isTrustedSender,
    isSetupSender: (frameUrl) => isSetupSender(frameUrl, SETUP_URL),
    parseDeploymentUrl: (input) => parseDeploymentUrl(input, app.isPackaged),
    onSetUrl: (origin) => {
      saveConfig({ deploymentUrl: origin });
      recreateWindow();
      buildPoller();
      // probe only after stop settles, or it sees the dying child and never restarts.
      void controller?.stop().then(() => controller?.probe());
    },
    supervisor: supervisorFacade,
    getConfiguredOrigin: configuredOrigin,
    sessionFetch,
    get runRoot() {
      return runRoot;
    },
    confirmPairElsewhere: async (pairedTo) => {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: `This computer is paired to ${pairedTo ?? "another Shiba"}.`,
        detail: `Pair it with ${configuredOrigin()} instead?`,
        buttons: ["Re-pair", "Cancel"],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
    readLocalConfig,
    log,
  });
  registerShellIpc({
    ipcMain,
    isTrustedSender,
    isDiffSender: (frame) => isSetupSender(frame, DIFF_URL),
    getConfiguredOrigin: configuredOrigin,
    loadDashboardPath: openPath,
    openExternal: (url) => shell.openExternal(url),
    presentDiff,
    readDiffPatch: () => diffPatch,
    receiveCodex: (authorizationUrl) =>
      receiveCodexCallback(authorizationUrl, async (url) => {
        await shell.openExternal(url);
        return true;
      }),
    cancelCodex: cancelCodexCallback,
    startClaudeLogin: () => startClaudeLogin({ env: shellEnv }),
  });
}

// Reads the daemon's config.json so revoke still has a machineId when the live
// status dropped it (conflict/crashed). Shared by the controller probe, the
// tray Disconnect path, and the desktop:unpair IPC handler.
function readLocalConfig(): { workerUrl?: string; machineId?: string } | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(runRoot, "config.json"), "utf8"));
  } catch {
    return null;
  }
}

function initController(): void {
  const daemonPath = resolveDaemonPath({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    repoRoot: path.resolve(__dirname, "..", "..", ".."),
  });
  controller = createController({
    getOrigin: configuredOrigin,
    probeFetch: (url) => sessionFetch(url),
    readLocalConfig,
    fork: (args, hooks) => forkDaemon({ daemonPath, args, env: shellEnv, ...hooks }),
    onStatus,
    onSettled: (msg) =>
      handleDaemonMessage(msg, {
        origin: configuredOrigin(),
        showWindow,
        loadURL: (url) => mainWindow?.loadURL(url),
        notify,
      }),
    log: (line) => (line.startsWith("daemon: ") ? daemonLog?.line(line.slice(8)) : log(line)),
  });
}

async function initIntegrations(): Promise<void> {
  const logsDir = path.join(app.getPath("userData"), "logs");
  mainLog = createLogger(logsDir, "main.log");
  daemonLog = createLogger(logsDir, "daemon.log");
  shellEnv = await captureShellEnv();
  runRoot = shellEnv.SHIBA_LOCAL_RUN_ROOT || path.join(os.homedir(), ".shiba-local");
  initController();
  buildPoller();
  const icon = trayIconPath();
  if (icon) tray = createTray(icon, onTraySelect);
  else log("tray icon missing; running without a tray item");
  refreshTray();
  applyLoginItem();
  startUpdater({
    isPackaged: app.isPackaged,
    checkForUpdatesAndNotify: checkForUpdates,
    log: (...a) => log(a.map(String).join(" ")),
  });
  powerMonitor.on("suspend", () => poller?.stop());
  powerMonitor.on("resume", () => {
    void controller?.probe();
    if (config.notifications !== false) void poller?.start();
  });
  await controller?.probe();
}

/** Quit stops the daemon first; a mid-run quit asks, since the run gets reported failed. */
function onBeforeQuit(event: Electron.Event): void {
  if (shutdownStarted) return;
  event.preventDefault();
  if (controller && shouldConfirmQuit(controller.status().state)) {
    const choice = dialog.showMessageBoxSync({
      type: "warning",
      message: "A local run is in progress.",
      detail: "Quitting stops it and reports it failed.",
      buttons: ["Quit", "Cancel"],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice !== 0) return;
  }
  shutdownStarted = true;
  quitting = true;
  poller?.stop();
  void (controller?.stop() ?? Promise.resolve()).finally(() => {
    controller?.dispose();
    tray?.destroy();
    app.exit(0);
  });
}

function registerProtocol(): void {
  try {
    if (app.isPackaged) {
      app.setAsDefaultProtocolClient("shiba");
      return;
    }
    const entry = process.argv[1];
    if (!entry) return;
    app.setAsDefaultProtocolClient("shiba", process.execPath, [path.resolve(entry)]);
  } catch (error) {
    log(`protocol registration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((arg) => arg.startsWith("shiba:"));
    if (link) handleDeepLink(link);
    else showWindow();
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleDeepLink(url);
  });
  app.on("before-quit", onBeforeQuit);
  app.on("activate", showWindow);
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });
  void app.whenReady().then(() => {
    config = loadConfig();
    registerProtocol();
    buildMenu();
    registerIpc();
    createWindow();
    if (mainWindow) configurePermissions(mainWindow);
    flushDeepLinks();
    void initIntegrations();
  });
}
