// Shared run-record shapes for the dashboard workbench.
// Single source of truth — app.tsx, WorkspacePanel, and future panes import
// these instead of redeclaring them.
export interface RetainedRun {
  runId: string;
  sandboxId: string;
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  status: string;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  error?: string;
  diff?: string;
}

export interface ToolRunPart {
  text?: string;
  delta?: string;
  message?: string;
  body?: string;
  [key: string]: unknown;
}

export interface ToolRunRecord {
  runId: string;
  status: string;
  agentType?: string;
  parentToolCallId?: string;
  parts: ToolRunPart[];
  summary?: string;
  error?: string;
  diff?: string;
  [key: string]: unknown;
}
