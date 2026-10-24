# Shiba Desktop plan

Modeled on [t3code `apps/desktop`](https://github.com/pingdotgg/t3code/tree/main/apps/desktop)
(cloned and read for this plan). Shiba does not port t3code's preview browser,
screenshot tool, SSH, or WSL. It keeps Shiba's approval gate and puts Claude
Code and Codex on the operator's machine.

The shell lives in `apps/desktop`. The task, diff, approval, and pull-request
screens are the dashboard at `https://app.tryshiba.dev/app/`. Apps do not
import each other.

## What t3code's desktop actually is

It is Electron, not Tauri. `@t3tools/desktop` (`apps/desktop/package.json`)
pins `electron` 44.9.3, `electron-updater` 6.8.9, and `electron-builder`
26.16.1. The package entry is `dist-electron/boot.cjs`. Vite bundles the main
process; the renderer is the web app, loaded through a privileged custom
scheme.

| Concern | Where it lives | What it does |
| --- | --- | --- |
| Shell | `src/main.ts`, `src/boot.ts`, `src/electron/ElectronApp.ts` | Effect layers. One main window. Single-instance activation. |
| Custom protocol | `src/electron/ElectronProtocol.ts` | `t3code://app` in production, `t3code-dev://app` in dev. Serves built assets or proxies the dev server. CSP is set on that response. |
| Window / session | `src/window/DesktopWindow.ts`, `src/app/DesktopState.ts` | One main `BrowserWindow`. Bounds persist. macOS hides on close. Clerk session lives in the Electron session, not in a second browser profile. |
| IPC | `src/preload.ts`, `src/ipc/channels.ts`, `src/ipc/DesktopIpc.ts` | `contextBridge` exposes `window.desktopBridge`. Channels are string constants. Handlers validate payloads. The preload is sandboxed. |
| Local runtime | `src/backend/DesktopBackendManager.ts` | The shell spawns the local server (`ChildProcess.make` + spawn). The server, not Electron, starts agent CLIs. Shell env is captured in `src/shell/DesktopShellEnvironment.ts`. |
| Codex login | `packages/shared/src/codexAuthCallback.ts`, `src/ipc/methods/providerAuth.ts` | PKCE stays on the computer. Main opens the authorize URL in the system browser, listens on `127.0.0.1` for `/auth/callback`, and returns that callback URL. It does not store the token. |
| Claude login | `apps/web/src/onboarding/providerReadiness.logic.ts` | The login command is `` `claude auth login` `` on the machine that runs Claude Code. The desktop does not proxy an Anthropic browser login. |
| Deep links | `src/electron/ElectronProtocol.ts`, `src/app/DesktopWebLinks.ts` | Custom scheme plus `http(s)` links. Provider callbacks are loopback first. |
| Auto-update | `src/updates/DesktopUpdates.ts`, `src/electron/ElectronUpdater.ts` | `electron-updater`, a state machine, channels, and a poller. Install is explicit. |
| Packaging | `scripts/build-desktop-artifact.ts` | electron-builder, fuses, mac hardened runtime, draft GitHub publish config. |

## Shiba shape

```
Electron main
  BrowserWindow  ->  https://app.tryshiba.dev/app/   (dashboard: tasks, diff, approvals, PR)
  preload        ->  window.shibaDesktop             (origin-gated)
  utilityProcess ->  scripts/shiba-local-daemon.mjs  (claim / run / result)
  loopback       ->  ChatGPT PKCE callback, handed back to POST /api/providers/codex/verify
  spawn          ->  claude auth login, then auth status (stdio ignored; real HOME)
```

Default origin is `https://app.tryshiba.dev`. A saved self-hosted URL replaces
it. Unpackaged `SHIBA_DESKTOP_URL` overrides both. `SHIBA_DESKTOP_SETUP=1`, or
an empty `SHIBA_DESKTOP_URL`, opens the bundled setup page.

The run HOME stays disposable. `scripts/link-operator-auth.mjs` copies
`.codex/auth.json` and `.claude/.credentials.json` into that home as mode
0444. It does not symlink the operator directories, so a task cannot write
the real credential files. The copies are not sent to the Worker.

## Workstreams

Status is for this branch.

### 1. Shell and packaging — built

**Owns:** `apps/desktop/package.json`, `electron-builder.yml`, `src/main.ts`, `src/launch.ts`, assets, fuses.

**Does not own:** dashboard components, Worker routes.

**Interface:** `resolveConfiguredOrigin` and `dashboardPath` in `launch.ts`. Packaged app id `dev.shiba.desktop`. Targets are macOS dmg + zip (arm64, x64). `pnpm --filter @shiba/desktop dist` passes `--publish never`.

### 2. IPC and preload — built

**Owns:** `src/preload.ts`, `src/diff-preload.ts`, `src/shell-ipc.ts`, `src/pairing.ts`, `packages/shared/src/desktop-bridge.ts`.

**Interface:** `ShibaDesktopBridge` on `window.shibaDesktop`, only when `location.origin` is the configured origin. The diff window gets `window.shibaDiff.patch()` and nothing else. Every handler re-checks the sender frame.

### 3. Local daemon and pairing — built

**Owns:** `scripts/shiba-local-daemon.mjs`, `scripts/link-operator-auth.mjs`, `src/supervisor.ts`, `src/controller.ts`, pairing IPC.

**Interface:** the renderer supplies a pairing token. Main builds `--connect <origin> --pair <token>`. The adapter bearer stays in `~/.shiba-local/config.json` and is never returned over IPC. `copyOperatorAuth(homeDir, userHome)` copies the subscription auth files into the run HOME.

### 4. Provider logins — built

**Owns:** `src/codex-callback.ts`, `src/claude-login.ts`, the provider buttons in `apps/frontend/src/components/ProvidersView.tsx`, `apps/frontend/src/desktop-provider.ts`.

**Reuses:** `POST /api/providers/codex/verify` with `{ callbackUrl }` (`apps/backend/src/provider-sign-in.ts`, loopback callback only) and the Claude daemon lane (`claude auth login` on the paired computer, then Finish sign-in). The desktop does not add an OAuth server and does not store provider tokens.

**Interface:**

- `receiveCodexCallback(authorizationUrl)` accepts only `https://auth.openai.com` with S256 PKCE and `redirect_uri` `http://127.0.0.1:<port>/auth/callback`. It returns that callback URL to the dashboard.
- `startClaudeLogin()` spawns `claude` with argv `auth login`, `stdio: "ignore"`, and the login-shell env. Exit status only.

### 5. Task UI — built

**Owns:** no new composer. The window loads `<origin>/app/`, which is `apps/frontend` (task composer, threads).

**Interface:** `openView("tasks")` loads `/app/`. Deep link `shiba://open/tasks`.

### 6. Diff viewer — built

**Owns:** `src/diff-summary.ts`, `src/diff.html`, `src/diff.js`. The run's diff UI is the dashboard Pull requests view (`DiffView`).

**Interface:** `showDiff(patch)` returns `{ files, hunks, additions, deletions }` and opens the desktop diff window. `openView("diff")` loads `/app/?tab=diff`. Patches larger than 512 KiB are refused. The patch is not logged.

### 7. Approval flow — built

**Owns:** `src/approvals-poller.ts`. Acting stays in the dashboard. The poller is GET-only and only notifies.

**Interface:** notification click and `openView("approvals")` load `/app/?tab=approvals`. Deep link `shiba://open/approvals`.

### 8. Pull request open — built

**Owns:** `src/pull-request.ts`. Creating the PR stays on the Worker after an approved local run. The shell only opens the link.

**Interface:** `openPullRequest(url)` accepts `https://github.com/<owner>/<repo>/pull/<n>` and calls `shell.openExternal`. Query and userinfo are stripped. Deep link `shiba://pr?url=`.

### 9. Auto-update and signing — built, unsigned

**Owns:** `src/updater.ts`, `electron-builder.yml` fuses, mac hardened runtime, `scripts/adhoc-sign.sh`.

**Interface:** `startUpdater` checks only when `app.isPackaged`. CI and `dist` pass `--publish never`. The tag workflow builds a signed zip/dmg when Apple secrets exist and does not publish a GitHub release.

### 10. End-to-end tests — built

**Owns:** `apps/desktop/test/*.test.ts`, `apps/desktop/test/smoke.e2e.ts`, `apps/desktop/test/journey.e2e.ts`.

**Interface:** unit tests run under `pnpm --filter @shiba/desktop test`. Electron tests run under `pnpm --filter @shiba/desktop test:e2e` (built `dist/`, a display). That script downloads the Electron binary once, then runs one e2e file at a time. Electron 44 has no postinstall, and two workers extracting the zip together truncate the macOS framework. The journey stub stands in for `app.tryshiba.dev`: probe reports unpaired, then the page sends a task, approves, shows the patch, and opens the pull URL.

## Run locally

```bash
pnpm install
pnpm --filter @shiba/desktop start
```

That signs in to `https://app.tryshiba.dev` unless `userData/config.json` has a deployment URL.

Self-hosted or local Worker:

```bash
SHIBA_DESKTOP_URL=http://127.0.0.1:8788 pnpm --filter @shiba/desktop start
```

First-run setup page (self-hosted URL form):

```bash
SHIBA_DESKTOP_SETUP=1 pnpm --filter @shiba/desktop start
```

Pair from the dashboard Remote Access page (Connect this computer). On this machine, `claude auth login` is the Claude Code button on Providers when the shell is present. Codex device sign-in stays the dashboard card; a ChatGPT PKCE authorize URL is received by the shell and posted to the existing verify route.

## Packaging

```bash
# unsigned, does not publish
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @shiba/desktop dist

# ad-hoc signature of the local arm64 app (macOS)
pnpm --filter @shiba/desktop dist:local
```

Output: `apps/desktop/release/`. Signed and notarized builds need `CSC_LINK`, `CSC_KEY_PASSWORD`, and the Apple API key env vars documented in `electron-builder.yml`. Do not tag `desktop-v*` from an agent run.

## Tests

```bash
pnpm --filter @shiba/desktop typecheck
pnpm --filter @shiba/desktop test
pnpm --filter @shiba/desktop test:e2e
pnpm --filter @shiba/frontend test -- src/desktop-provider.test.ts
```

## Left

- Apple signing secrets are not in this environment, so the packaged app is unsigned here.
- No GitHub release is published.
- A live walk against `https://app.tryshiba.dev` with a real Claude Code or Codex subscription is a manual check. The Electron journey uses a loopback stand-in.
- Linux and Windows targets are not in v1.
- The daemon still gives each run its own HOME. Only `.codex/auth.json` and `.claude/.credentials.json` are copied in, read-only, and only when the run did not already write those files.
