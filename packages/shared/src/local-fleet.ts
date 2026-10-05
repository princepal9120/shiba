/**
 * T52-T55 Remote Access: the paired-daemon fleet. Plain interfaces and
 * constants only — Worker-side validation is Effect Schema
 * (apps/backend/src/local-fleet-schema.ts), the daemon mirrors by hand.
 */

export type ComputerStatus = "idle" | "busy" | "offline";

export const DAEMON_HARNESSES = ["claude", "codex", "opencode", "agy"] as const;
export type DaemonHarness = (typeof DAEMON_HARNESSES)[number];

/** Known `process.platform-process.arch` values; the wire field stays a string. */
export type DaemonPlatform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64";

export interface ConnectedComputer {
  machineId: string;
  hostname: string;
  platform: string;
  daemonVersion: string;
  harnesses: string[];
  status: ComputerStatus;
  lastHeartbeat: number;
  pairedAt?: number;
  activeRunId?: string;
}

export interface HeartbeatRequest {
  machineId: string;
  hostname: string;
  platform: string;
  daemonVersion: string;
  harnesses: string[];
  activeRunId?: string;
}

export interface PairRequest {
  pairingToken: string;
  hostname: string;
  platform: string;
  daemonVersion: string;
  harnesses: string[];
}

export interface PairResponse {
  adapterToken: string;
  machineId: string;
}

export interface PairingTokenResponse {
  token: string;
  expiresAt: number;
  connectCommand: string;
}

/** Two missed 30s heartbeats plus slack before a machine reads offline. */
export const LOCAL_HEARTBEAT_STALE_MS = 75_000;
export const LOCAL_COMPUTER_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;
export const LOCAL_PAIRING_TTL_MS = 15 * 60 * 1000;
