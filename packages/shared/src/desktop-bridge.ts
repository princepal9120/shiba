export type DesktopDaemonState =
  | "signed-out"
  | "disabled"
  | "unpaired"
  | "paired-elsewhere"
  | "starting"
  | "idle"
  | "busy"
  | "offline"
  | "revoked"
  | "conflict"
  | "crashed";

export interface DesktopStatus {
  state: DesktopDaemonState;
  machineId?: string; // not a secret; marks "This computer" in the fleet list
  activeRunId?: string;
  harnesses?: string[];
  pairedTo?: string; // only for paired-elsewhere: the other origin
  detail?: string; // human-readable; never contains a token
}

export type PairResult = { ok: true } | { ok: false; error: string };

/** Views the shell can open in the dashboard. The page at that path is the dashboard's. */
export type DesktopViewName = "tasks" | "diff" | "approvals" | "providers" | "remote";

export type DesktopFailure = { ok: false; error: string };

export type DesktopCodexCallbackResult = { ok: true; callbackUrl: string } | DesktopFailure;

export type DesktopClaudeLoginResult = { ok: true } | DesktopFailure;

export interface DesktopDiffSummary {
  ok: true;
  files: string[];
  hunks: number;
  additions: number;
  deletions: number;
}

export type DesktopDiffResult = DesktopDiffSummary | DesktopFailure;

export type DesktopPullRequestResult = { ok: true; url: string } | DesktopFailure;

export interface ShibaDesktopBridge {
  readonly version: string;
  status(): Promise<DesktopStatus>;
  pair(pairingToken: string): Promise<PairResult>;
  unpair(): Promise<PairResult>;
  onStatus(listener: (status: DesktopStatus) => void): () => void;
  /** Loopback receiver for a ChatGPT PKCE authorize URL. The code is returned to the dashboard, which posts it to the existing verify route. */
  receiveCodexCallback(authorizationUrl: string): Promise<DesktopCodexCallbackResult>;
  cancelCodexCallback(authorizationUrl: string): Promise<void>;
  /** Spawns `claude auth login` on this machine. Stdout is discarded; credentials stay in the user's Claude home. */
  startClaudeLogin(): Promise<DesktopClaudeLoginResult>;
  /** Loads a dashboard view (`/app/` or `/app/?tab=`). */
  openView(view: DesktopViewName): Promise<void>;
  /** Hands a github.com pull URL to the system browser. */
  openPullRequest(url: string): Promise<DesktopPullRequestResult>;
  /** Parses a unified diff and opens the desktop diff window. The dashboard diff tab remains the run's viewer. */
  showDiff(patch: string): Promise<DesktopDiffResult>;
}

// Daemon → main over process.parentPort (hand-mirrored in the dep-free daemon).
export type DaemonStatusMessage =
  | { type: "status"; state: "polling"; machineId: string; harnesses: string[] }
  | { type: "status"; state: "claimed"; runId: string; harness: string; repoUrl: string }
  // Sent after the result POST. `posted` = the Worker accepted it. `status` is the daemon's
  // own view; harness.verify and PR publish still run Worker-side (§11.7).
  | {
      type: "status";
      state: "settled";
      runId: string;
      status: string;
      exitCode: number;
      repoUrl: string;
      posted: boolean;
    }
  | { type: "status"; state: "heartbeat"; ok: boolean };
