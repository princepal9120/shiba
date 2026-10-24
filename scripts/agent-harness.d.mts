export interface SessionEvent {
  type: string;
  text?: string;
  patch?: string;
  name?: string;
}

export interface SessionHandle {
  id: string;
  threadId: string;
  logPath: string;
  turn(prompt: string): Promise<{ status: string; summary: string }>;
  resume(threadId: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionJobResult {
  exitCode: number;
  status: string;
  summary: string;
  threadId: string;
  diff: string;
  events: SessionEvent[];
  logPath: string;
}

export function eventText(event: SessionEvent): string;
export function runSessionJob(job: Record<string, unknown>): Promise<SessionJobResult>;
export function createSessionManager(): {
  open(spec: Record<string, unknown>): Promise<SessionHandle>;
  list(): string[];
  closeAll(): Promise<void>;
};
export function readEventLog(logPath: string): Promise<{ seq: number; event: SessionEvent }[]>;
export function parseSessionLine(line: string): SessionEvent | null;
export function captureWorktreeCheckpoint(
  cwd: string,
  sessionId: string,
  seq: number,
  env: Record<string, string | undefined>,
): Promise<string>;
export function diffCheckpointRefs(
  cwd: string,
  fromRef: string,
  toRef: string,
  env: Record<string, string | undefined>,
): Promise<string>;
