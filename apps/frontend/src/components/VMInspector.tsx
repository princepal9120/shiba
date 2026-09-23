import { useState, useEffect, useCallback, useMemo, type JSX } from "react";
import { DiffViewer } from "./DiffViewer";
import { formatTimeAgo, parseRepoName, statusLabel } from "../ui-helpers";

export interface VMRun {
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

export interface VMInspectorProps {
  runs: VMRun[];
  selectedRunId?: string | null;
  onSelectRun?: (runId: string) => void;
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size?: number;
}

interface ProcessEntry {
  pid: number;
  command: string;
  status?: string;
}

interface SandboxInfo {
  sandboxId: string;
  available: boolean;
  placementId?: string | null;
  processes?: ProcessEntry[];
  allowedHosts?: string[];
  defaultPort?: number;
}

export function VMInspector({ runs, selectedRunId, onSelectRun }: VMInspectorProps): JSX.Element {
  const [activeRunId, setActiveRunId] = useState<string>(selectedRunId || runs[0]?.runId || "");
  const [subTab, setSubTab] = useState<"diff" | "files" | "terminal" | "preview" | "processes">("diff");
  
  // File Explorer State
  const [currentPath, setCurrentPath] = useState<string>("/workspace");
  const [fileList, setFileList] = useState<FileEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState<boolean>(false);
  
  // Terminal / Exec State
  const [customCommand, setCustomCommand] = useState<string>("");
  const [formState, setFormState] = useState<{ errors: { command?: string } }>({
    errors: {},
  });
  const [isPending, setIsPending] = useState<boolean>(false);
  const [terminalHistory, setTerminalHistory] = useState<Array<{ command: string; stdout: string; stderr: string; exitCode: number; time: string }>>([]);

  // Sandbox Live Info
  const [sandboxInfo, setSandboxInfo] = useState<SandboxInfo | null>(null);
  const [infoLoading, setInfoLoading] = useState<boolean>(false);

  // Web Preview Port
  const [previewPort, setPreviewPort] = useState<number>(3000);
  const [previewUrlInput, setPreviewUrlInput] = useState<string>("");

  // Share Notification
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  // Synchronize active run with props
  useEffect(() => {
    if (selectedRunId && selectedRunId !== activeRunId) {
      setActiveRunId(selectedRunId);
    } else if (!activeRunId && runs.length > 0) {
      setActiveRunId(runs[0]?.runId ?? "");
    }
  }, [selectedRunId, runs, activeRunId]);

  const activeRun = useMemo(() => {
    return runs.find((r) => r.runId === activeRunId) || runs[0];
  }, [runs, activeRunId]);

  const sandboxId = activeRun?.sandboxId || "";

  // Fetch sandbox container info
  const fetchSandboxInfo = useCallback(async (sbId: string) => {
    if (!sbId) return;
    setInfoLoading(true);
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sbId)}/info`);
      if (res.ok) {
        const data = (await res.json()) as SandboxInfo;
        setSandboxInfo(data);
      } else {
        setSandboxInfo({ sandboxId: sbId, available: false });
      }
    } catch {
      setSandboxInfo({ sandboxId: sbId, available: false });
    } finally {
      setInfoLoading(false);
    }
  }, []);

  // Fetch directory files
  const fetchFiles = useCallback(async (sbId: string, path: string) => {
    if (!sbId) return;
    setFileLoading(true);
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sbId)}/files?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = (await res.json()) as { files?: FileEntry[] };
        const rawFiles = Array.isArray(data.files) ? data.files : [];
        setFileList(rawFiles);
      } else {
        setFileList([]);
      }
    } catch {
      setFileList([]);
    } finally {
      setFileLoading(false);
    }
  }, []);

  // Fetch single file content
  const fetchFileContent = useCallback(async (sbId: string, path: string) => {
    if (!sbId) return;
    setFileLoading(true);
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sbId)}/file?path=${encodeURIComponent(path)}`);
      if (res.ok) {
        const data = (await res.json()) as { content?: string };
        setFileContent(data.content ?? "");
        setSelectedFile(path);
      } else {
        setFileContent(null);
      }
    } catch {
      setFileContent(null);
    } finally {
      setFileLoading(false);
    }
  }, []);

  // Execute terminal command inside VM
  const executeCommand = useCallback(async (cmd: string) => {
    if (!cmd.trim() || !sandboxId) return;
    setIsPending(true);
    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(sandboxId)}/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: cmd, cwd: currentPath || "/workspace" }),
      });
      const timeStr = new Date().toLocaleTimeString();
      if (res.ok) {
        const data = (await res.json()) as { stdout?: string; stderr?: string; exitCode?: number };
        setTerminalHistory((prev) => [
          ...prev,
          {
            command: cmd,
            stdout: data.stdout || "",
            stderr: data.stderr || "",
            exitCode: data.exitCode ?? 0,
            time: timeStr,
          },
        ]);
      } else {
        const errText = await res.text();
        setTerminalHistory((prev) => [
          ...prev,
          {
            command: cmd,
            stdout: "",
            stderr: `Failed to execute: ${errText}`,
            exitCode: res.status,
            time: timeStr,
          },
        ]);
      }
    } catch (err: unknown) {
      setTerminalHistory((prev) => [
        ...prev,
        {
          command: cmd,
          stdout: "",
          stderr: String(err),
          exitCode: -1,
          time: new Date().toLocaleTimeString(),
        },
      ]);
    } finally {
      setIsPending(false);
    }
  }, [sandboxId, currentPath]);

  // When active run changes, refresh VM info
  useEffect(() => {
    if (sandboxId) {
      void fetchSandboxInfo(sandboxId);
      void fetchFiles(sandboxId, "/workspace");
    }
  }, [sandboxId, fetchSandboxInfo, fetchFiles]);

  // Share VM URL
  const copyShareLink = () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("run", activeRunId);
    url.searchParams.set("tab", "vm-inspector");
    void navigator.clipboard.writeText(url.toString());
    setCopiedLink(true);
    setTimeout(() => setCopiedLink(false), 2500);
  };

  if (!activeRun) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-12 text-center bg-[var(--background)]">
        <div className="w-16 h-16 rounded-2xl bg-[var(--background)] border border-[var(--border)] flex items-center justify-center mb-4 text-blue-600">
          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <h3 className="text-base font-semibold text-slate-900 mb-1">No Virtual Machine Selected</h3>
        <p className="text-xs text-slate-500 max-w-sm">
          Run or select a coding task to inspect its live sandbox environment, inspect workspace files, run terminal commands, and view web previews.
        </p>
      </div>
    );
  }

  const isLive = activeRun.status === "running" || activeRun.status === "pending";

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--background)] text-slate-900">
      {/* VM TOP BAR: Selector, Status, and Share Link */}
      <div className="h-14 border-b border-[var(--border)] bg-[var(--card)]/95 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between shrink-0 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-blue-600 font-mono text-sm font-semibold flex items-center gap-1.5">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
              VM Inspector
            </span>
          </div>

          {/* Run Switcher Dropdown */}
          <div className="relative">
            <select
              aria-label="Select run"
              value={activeRunId}
              onChange={(e) => {
                const nextId = e.target.value;
                setActiveRunId(nextId);
                onSelectRun?.(nextId);
              }}
              className="bg-white text-xs font-mono text-slate-900 border border-[var(--border)] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[#0000a8] max-w-[220px] sm:max-w-xs truncate cursor-pointer"
            >
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {parseRepoName(r.repoUrl)} · {r.status.toUpperCase()} ({r.runId.slice(0, 16)})
                </option>
              ))}
            </select>
          </div>

          {/* Sandbox Status Badge */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-mono border border-[var(--border)] bg-white">
            <span
              className={`w-2 h-2 rounded-full ${
                isLive
                  ? "bg-blue-600 animate-pulse"
                  : activeRun.status === "completed"
                  ? "bg-[#15803d]"
                  : "bg-[#fb2c36]"
              }`}
            />
            <span className="text-slate-500">{statusLabel(activeRun.status)}</span>
            {sandboxInfo?.placementId ? (
              <span className="text-slate-500 opacity-70">({sandboxInfo.placementId})</span>
            ) : null}
          </div>
        </div>

        {/* Action Buttons: Share View Link & Refresh */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={copyShareLink}
            className="text-xs bg-white hover:bg-[var(--secondary)] border border-[var(--border)] text-slate-900 font-medium py-1.5 px-3 rounded-lg transition-colors flex items-center gap-1.5 shadow-sm"
            title="Copy shareable link for teammates to view this virtual machine"
          >
            {copiedLink ? (
              <>
                <svg className="w-3.5 h-3.5 text-[#15803d]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-[#15803d]">Link Copied!</span>
              </>
            ) : (
              <>
                <svg className="w-3.5 h-3.5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                </svg>
                <span>Share VM View</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              void fetchSandboxInfo(sandboxId);
              void fetchFiles(sandboxId, currentPath);
            }}
            className="text-xs bg-white hover:bg-[var(--secondary)] border border-[var(--border)] text-slate-500 hover:text-slate-900 p-1.5 rounded-lg transition-colors"
            title="Refresh VM state"
          >
            <svg className={`w-4 h-4 ${infoLoading ? "animate-spin text-blue-600" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>
      </div>

      {/* METADATA STRIP: Repository, Task, Branch, Sandbox ID */}
      <div className="bg-[var(--card)]/70 border-b border-[var(--border)] px-4 lg:px-6 py-2.5 flex flex-wrap items-center justify-between gap-y-2 gap-x-4 text-xs font-mono text-slate-500">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <span className="text-slate-900 font-semibold flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-blue-600" fill="currentColor" viewBox="0 0 24 24">
              <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
            </svg>
            {parseRepoName(activeRun.repoUrl)}
          </span>
          <span>Branch: <span className="text-slate-900">{activeRun.baseBranch}</span></span>
          <span>Sandbox ID: <span className="text-blue-600">{activeRun.sandboxId}</span></span>
          {activeRun.publishPullRequest ? (
            <span className="text-blue-600 bg-blue-600/10 border border-[#0000a8]/10 px-1.5 py-0.2 rounded text-[10px]">
              PR Enabled
            </span>
          ) : null}
        </div>
        <div className="text-[11px] text-slate-500">
          Started {formatTimeAgo(activeRun.createdAt)}
        </div>
      </div>

      {/* TASK DESCRIPTION SUMMARY */}
      <div className="bg-[var(--background)] border-b border-[var(--border)] px-4 lg:px-6 py-2 flex items-center justify-between text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-slate-500 shrink-0 font-medium">Task:</span>
          <span className="text-slate-900 truncate font-sans">{activeRun.task}</span>
        </div>
        {activeRun.summary ? (
          <span className="text-[11px] text-blue-600 shrink-0 font-mono hidden md:inline-block">
            Summary available
          </span>
        ) : null}
      </div>

      {/* SUB-TABS NAVIGATION */}
      <div className="border-b border-[var(--border)] bg-[var(--background)] px-4 lg:px-6 flex items-center gap-1 shrink-0 overflow-x-auto">
        <button
          type="button"
          onClick={() => setSubTab("diff")}
          className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            subTab === "diff"
              ? "border-[#0000a8] text-blue-600 font-semibold bg-[color-mix(in_srgb,var(--line)_30%,transparent)]"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
          <span>Changes & Diff</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab("files")}
          className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            subTab === "files"
              ? "border-[#0000a8] text-blue-600 font-semibold bg-[color-mix(in_srgb,var(--line)_30%,transparent)]"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span>Workspace Files</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab("terminal")}
          className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            subTab === "terminal"
              ? "border-[#0000a8] text-blue-600 font-semibold bg-[color-mix(in_srgb,var(--line)_30%,transparent)]"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span>Terminal & Exec</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab("preview")}
          className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            subTab === "preview"
              ? "border-[#0000a8] text-blue-600 font-semibold bg-[color-mix(in_srgb,var(--line)_30%,transparent)]"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          <span>Web Preview</span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab("processes")}
          className={`px-3 py-2.5 text-xs font-medium border-b-2 transition-colors flex items-center gap-1.5 whitespace-nowrap ${
            subTab === "processes"
              ? "border-[#0000a8] text-blue-600 font-semibold bg-[color-mix(in_srgb,var(--line)_30%,transparent)]"
              : "border-transparent text-slate-500 hover:text-slate-900"
          }`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          <span>System & Processes</span>
        </button>
      </div>

      {/* SUB-TAB CONTENTS */}
      <div className="flex-1 overflow-y-auto p-4 lg:p-6 bg-white">
        {/* 1. CHANGES & DIFF TAB */}
        {subTab === "diff" ? (
          <div className="flex flex-col gap-4 max-w-5xl mx-auto">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Work in Progress Diff</h3>
                <p className="text-xs text-slate-500">
                  All uncommitted and committed modifications made in this virtual machine workspace.
                </p>
              </div>
            </div>

            {activeRun.diff ? (
              <DiffViewer diff={activeRun.diff} runId={activeRun.runId} />
            ) : (
              <div className="py-16 text-center border border-dashed border-[var(--border)] rounded-xl bg-[var(--card)]/50 p-6">
                <p className="text-sm text-slate-500 mb-1">No file changes produced yet</p>
                <p className="text-xs text-slate-500/70">
                  {isLive
                    ? "The coding agent is currently planning or editing files in the sandbox container."
                    : "This task did not generate any Git diff output."}
                </p>
              </div>
            )}

            {activeRun.summary ? (
              <div className="mt-4 border border-[var(--border)] rounded-xl bg-[var(--background)] p-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-blue-600 mb-2 font-mono">
                  Agent Execution Summary
                </h4>
                <pre className="font-mono text-xs text-slate-900 whitespace-pre-wrap leading-relaxed">
                  {activeRun.summary}
                </pre>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* 2. WORKSPACE FILES TAB */}
        {subTab === "files" ? (
          <div className="flex flex-col xl:flex-row gap-4 h-full min-h-[480px]">
            {/* Left: File Tree */}
            <div className="w-full xl:w-72 bg-[var(--background)] border border-[var(--border)] rounded-xl p-3 flex flex-col shrink-0">
              <div className="flex items-center justify-between pb-2 mb-2 border-b border-[var(--border)] text-xs font-mono">
                <span className="text-slate-500 truncate">{currentPath}</span>
                <button
                  type="button"
                  onClick={() => {
                    const parent = currentPath.substring(0, currentPath.lastIndexOf("/")) || "/";
                    setCurrentPath(parent);
                    void fetchFiles(sandboxId, parent);
                  }}
                  className="text-blue-600 hover:text-blue-600 text-[11px]"
                  title="Up directory"
                >
                  ../
                </button>
              </div>

              {fileLoading && fileList.length === 0 ? (
                <div className="text-xs text-slate-500 p-4 text-center">Loading files...</div>
              ) : fileList.length === 0 ? (
                <div className="text-xs text-slate-500 p-4 text-center">
                  No files found or container unavailable.
                </div>
              ) : (
                <div className="flex-1 overflow-y-auto flex flex-col gap-1 pr-1 font-mono text-xs">
                  {fileList.map((entry) => (
                    <button
                      key={entry.path}
                      type="button"
                      onClick={() => {
                        if (entry.isDirectory) {
                          setCurrentPath(entry.path);
                          void fetchFiles(sandboxId, entry.path);
                        } else {
                          void fetchFileContent(sandboxId, entry.path);
                        }
                      }}
                      className={`text-left px-2 py-1.5 rounded flex items-center gap-2 truncate transition-colors ${
                        selectedFile === entry.path
                          ? "bg-blue-600/10 text-blue-600 border border-[#0000a8]/15"
                          : "hover:bg-[var(--secondary)] text-slate-900"
                      }`}
                    >
                      <svg
                        className={`w-3.5 h-3.5 shrink-0 ${entry.isDirectory ? "text-[#b45309]" : "text-blue-600"}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        {entry.isDirectory ? (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                        ) : (
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        )}
                      </svg>
                      <span className="truncate">{entry.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right: Code Viewer */}
            <div className="flex-1 bg-[var(--background)] border border-[var(--border)] rounded-xl flex flex-col overflow-hidden">
              <div className="h-10 border-b border-[var(--border)] px-4 bg-[var(--background)] flex items-center justify-between text-xs font-mono">
                <span className="text-blue-600 truncate">
                  {selectedFile || "Select a file to inspect code"}
                </span>
                {fileContent !== null ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (fileContent) void navigator.clipboard.writeText(fileContent);
                    }}
                    className="text-[11px] text-slate-500 hover:text-slate-900"
                  >
                    Copy content
                  </button>
                ) : null}
              </div>

              <div className="flex-1 overflow-auto p-4 bg-white font-mono text-xs">
                {fileContent !== null ? (
                  <pre className="whitespace-pre text-slate-900 leading-relaxed">
                    {fileContent}
                  </pre>
                ) : (
                  <div className="h-full flex items-center justify-center text-slate-500 italic">
                    Click any file on the left to read its contents directly from the virtual machine.
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {/* 3. TERMINAL & EXEC TAB */}
        {subTab === "terminal" ? (
          <div className="flex flex-col gap-4 max-w-5xl mx-auto">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Live Virtual Machine Terminal</h3>
                <p className="text-xs text-slate-500">
                  Run diagnostics and inspect commands directly inside the micro-container.
                </p>
              </div>

              {/* Quick Presets */}
              <div className="flex flex-wrap gap-1.5 text-xs font-mono">
                {["git status", "git log -n 3", "ls -la /workspace", "cat package.json"].map((cmd) => (
                  <button
                    key={cmd}
                    type="button"
                    onClick={() => void executeCommand(cmd)}
                    className="px-2.5 py-1 rounded bg-white border border-[var(--border)] hover:bg-[var(--secondary)] text-slate-900 transition-colors"
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            </div>

            {/* Terminal Window */}
            <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl overflow-hidden shadow-2xl flex flex-col min-h-[380px]">
              <div className="h-8 bg-white border-b border-[var(--border)] px-3 flex items-center justify-between text-xs font-mono text-slate-500">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-[#fb2c36]/80" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#b45309]/80" />
                  <span className="w-2.5 h-2.5 rounded-full bg-[#15803d]/80" />
                  <span className="ml-2 text-slate-900">sandbox@cloudflare-vm:~/workspace</span>
                </div>
                <span>shiba-bash v1</span>
              </div>

              {/* Output Scroll Area */}
              <div className="flex-1 p-4 overflow-y-auto font-mono text-xs bg-white flex flex-col gap-4 max-h-[500px]">
                {terminalHistory.length === 0 ? (
                  <div className="text-slate-500 italic">
                    Terminal ready. Click a preset above or enter a bash command below to execute inside the container.
                  </div>
                ) : (
                  terminalHistory.map((item, idx) => (
                    <div key={idx} className="flex flex-col gap-1 border-b border-[var(--border)]/60 pb-3">
                      <div className="flex items-center justify-between text-slate-500 text-[11px]">
                        <div className="flex items-center gap-1.5 text-blue-600 font-semibold">
                          <span>$</span>
                          <span className="text-slate-900">{item.command}</span>
                        </div>
                        <span>exit code: {item.exitCode} · {item.time}</span>
                      </div>
                      {item.stdout ? (
                        <pre className="text-slate-900 whitespace-pre-wrap pl-3 border-l-2 border-[#0000a8]/30">
                          {item.stdout}
                        </pre>
                      ) : null}
                      {item.stderr ? (
                        <pre className="text-[#fb2c36] whitespace-pre-wrap pl-3 border-l-2 border-[#fb2c36]/40">
                          {item.stderr}
                        </pre>
                      ) : null}
                    </div>
                  ))
                )}
                {isPending ? (
                  <div className="text-blue-600 flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-blue-600 animate-ping" />
                    Executing command in container...
                  </div>
                ) : null}
              </div>

              {/* Command Input Bar */}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!customCommand.trim()) {
                    setFormState({ errors: { command: "Enter a command to run." } });
                    return;
                  }
                  setFormState({ errors: {} });
                  void executeCommand(customCommand);
                  setCustomCommand("");
                }}
                className="h-12 border-t border-[var(--border)] bg-white px-3 flex items-center gap-2"
              >
                <span className="text-blue-600 font-mono text-xs font-bold">$</span>
                <input
                  type="text"
                  required={true}
                  aria-label="Sandbox command"
                  value={customCommand}
                  onChange={(e) => setCustomCommand(e.target.value)}
                  placeholder="Enter command (e.g. npm test, ls -lh, git diff)..."
                  className="flex-1 bg-transparent border-none text-xs font-mono text-slate-900 focus:outline-none placeholder:text-slate-500/50"
                  disabled={isPending}
                />
                <button
                  type="submit"
                  disabled={isPending || !customCommand.trim()}
                  className="bg-blue-600 hover:bg-blue-600 disabled:opacity-40 text-white font-semibold text-xs px-3 py-1 rounded transition-colors"
                >
                  Run
                </button>
                {formState.errors.command ? (
                  <p role="alert" className="text-[#fb2c36] text-[11px] font-mono">
                    {formState.errors.command}
                  </p>
                ) : null}
              </form>
            </div>
          </div>
        ) : null}

        {/* 4. WEB PREVIEW TAB */}
        {subTab === "preview" ? (
          <div className="flex flex-col gap-4 max-w-5xl mx-auto h-full">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Cloudflare Sandbox Web Preview</h3>
                <p className="text-xs text-slate-500">
                  Inspect the web app running inside the micro-container on exposed ports.
                </p>
              </div>

              {/* Port Selector */}
              <div className="flex items-center gap-2 font-mono text-xs">
                <span className="text-slate-500">Port:</span>
                {[3000, 5173, 8080].map((port) => (
                  <button
                    key={port}
                    type="button"
                    onClick={() => setPreviewPort(port)}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      previewPort === port
                        ? "bg-blue-600/10 border-[#0000a8] text-blue-600 font-semibold"
                        : "bg-white border-[var(--border)] text-slate-500 hover:text-slate-900"
                    }`}
                  >
                    {port}
                  </button>
                ))}
              </div>
            </div>

            {/* Preview Guide Card */}
            <div className="border border-[var(--border)] bg-[var(--background)] rounded-xl p-5 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>How Sandbox Web Preview Works</span>
              </div>
              <p className="text-xs text-slate-500 leading-relaxed">
                Cloudflare Sandbox exposes container ports via subdomain routing using the pattern:
                <code className="bg-white text-blue-600 px-1.5 py-0.5 rounded border border-[var(--border)] mx-1">
                  https://{previewPort}-{sandboxId}-token.your-domain.workers.dev
                </code>
                When an agent or command launches a dev server (e.g. Vite, Next.js, or Express), Cloudflare&apos;s
                <code className="bg-white text-blue-600 px-1.5 py-0.5 rounded border border-[var(--border)] mx-1">
                  proxyToSandbox
                </code>
                forwards HTTP traffic securely into the container.
              </p>

              <div className="flex items-center gap-3 pt-2">
                <input
                  type="text"
                  aria-label="Custom preview URL or token"
                  value={previewUrlInput}
                  onChange={(e) => setPreviewUrlInput(e.target.value)}
                  placeholder="Optional custom preview URL or token..."
                  className="flex-1 bg-white text-xs font-mono text-slate-900 border border-[var(--border)] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[#0000a8]"
                />
              </div>
            </div>

            {/* Embedded Preview Frame */}
            <div className="flex-1 border border-[var(--border)] rounded-xl bg-[var(--background)] flex flex-col min-h-[350px] overflow-hidden">
              <div className="h-9 bg-white border-b border-[var(--border)] px-4 flex items-center justify-between text-xs font-mono text-slate-500">
                <span>Preview Frame (Port {previewPort})</span>
                <span className="text-[11px] text-blue-600">Isolated Sandbox Network</span>
              </div>
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-center bg-[var(--background)]">
                <svg className="w-12 h-12 text-blue-600/50 mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <h4 className="text-sm font-semibold text-slate-900 mb-1">Sandbox Web Application</h4>
                <p className="text-xs text-slate-500 max-w-md mb-4">
                  To view live web services, launch your application inside the container using the Terminal tab:
                  <code className="block mt-2 bg-white p-2 rounded text-blue-600 font-mono text-xs">
                    npm run dev -- --host 0.0.0.0 --port {previewPort}
                  </code>
                </p>
              </div>
            </div>
          </div>
        ) : null}

        {/* 5. SYSTEM & PROCESSES TAB */}
        {subTab === "processes" ? (
          <div className="flex flex-col gap-4 max-w-5xl mx-auto">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Container System & Security</h3>
                <p className="text-xs text-slate-500">
                  Hardware, isolation boundary, running processes, and egress firewall rules.
                </p>
              </div>
            </div>

            {/* Info Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-1">
                <span className="text-xs text-slate-500">Container Status</span>
                <span className="text-base font-semibold text-slate-900 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${sandboxInfo?.available ? "bg-[#15803d]" : "bg-[#b45309]"}`} />
                  {sandboxInfo?.available ? "Active & Reachable" : "Ephemeral (Sleeping/Terminated)"}
                </span>
              </div>

              <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-1">
                <span className="text-xs text-slate-500">Placement Region</span>
                <span className="text-base font-semibold text-slate-900 font-mono">
                  {sandboxInfo?.placementId || "Cloudflare Edge Global"}
                </span>
              </div>

              <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-1">
                <span className="text-xs text-slate-500">Default Network Port</span>
                <span className="text-base font-semibold text-slate-900 font-mono">
                  Port {sandboxInfo?.defaultPort || 3000}
                </span>
              </div>
            </div>

            {/* Allowed Egress Hosts */}
            <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-5 flex flex-col gap-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-blue-600 font-mono">
                Egress Security Allowlist (Zero-Trust)
              </h4>
              <p className="text-xs text-slate-500">
                All container outbound traffic is strictly gated. The micro-container has no access to internal secrets or unscoped external networks.
              </p>
              <div className="flex flex-wrap gap-2 pt-1 font-mono text-xs">
                {(sandboxInfo?.allowedHosts || [
                  "generativelanguage.googleapis.com",
                  "api.anthropic.com",
                  "api.openai.com",
                  "github.com",
                  "codeload.github.com",
                ]).map((host) => (
                  <span key={host} className="bg-white border border-[var(--border)] text-[#15803d] px-2.5 py-1 rounded-lg">
                    ✓ {host}
                  </span>
                ))}
              </div>
            </div>

            {/* Processes Table */}
            <div className="bg-[var(--background)] border border-[var(--border)] rounded-xl p-5 flex flex-col gap-3">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-900 font-mono">
                Running Container Processes
              </h4>
              {sandboxInfo?.processes && sandboxInfo.processes.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left font-mono text-xs">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-slate-500">
                        <th className="pb-2">PID</th>
                        <th className="pb-2">Command</th>
                        <th className="pb-2">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[color:color-mix(in_srgb,var(--line)_50%,transparent)]">
                      {sandboxInfo.processes.map((proc, i) => (
                        <tr key={i}>
                          <td className="py-2 text-blue-600">{proc.pid}</td>
                          <td className="py-2 text-slate-900">{proc.command}</td>
                          <td className="py-2 text-slate-500">{proc.status || "running"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-slate-500 italic">
                  No active user background processes registered.
                </p>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

