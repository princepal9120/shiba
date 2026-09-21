import { useState, useMemo, type JSX } from "react";
import { Tooltip } from "./Tooltip";

export interface DiffViewerProps {
  diff: string;
  runId?: string;
}

type LineKind = "file" | "hunk" | "add" | "del" | "context";

function classifyLine(line: string): LineKind {
  if (
    line.startsWith("diff --git") ||
    line.startsWith("+++") ||
    line.startsWith("---") ||
    line.startsWith("index ")
  ) {
    return "file";
  }
  if (line.startsWith("@@")) {
    return "hunk";
  }
  if (line.startsWith("+")) {
    return "add";
  }
  if (line.startsWith("-")) {
    return "del";
  }
  return "context";
}

const LINE_CLASSES: Record<LineKind, string> = {
  file: "font-medium text-zinc-100 bg-[#101013] border-y border-white/[0.07] py-1 px-2 rounded block font-mono text-[11px]",
  hunk: "text-zinc-400 font-mono text-[11px] bg-white/[0.03] py-0.5 px-2 block my-0.5 rounded",
  add: "text-[#4cc38a] block w-full px-2 -mx-2",
  del: "text-[#f06666] block w-full px-2 -mx-2",
  context: "text-zinc-500 block px-2",
};

export function DiffViewer({ diff, runId }: DiffViewerProps): JSX.Element {
  const [copied, setCopied] = useState(false);

  const stats = useMemo(() => {
    if (!diff) return { additions: 0, deletions: 0, files: 0 };
    const lines = diff.split("\n");
    let additions = 0;
    let deletions = 0;
    let files = 0;
    for (const line of lines) {
      if (line.startsWith("diff --git")) files++;
      else if (line.startsWith("+") && !line.startsWith("+++")) additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) deletions++;
    }
    return { additions, deletions, files };
  }, [diff]);

  if (!diff) {
    return <p className="text-xs text-zinc-500 italic">No file changes produced</p>;
  }

  const lines = diff.split("\n");

  const copyDiff = async () => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(diff);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        // Fallback or ignore
      }
    }
  };

  const downloadPatch = () => {
    if (typeof document === "undefined") return;
    const blob = new Blob([diff], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `patch-${runId || "task"}.diff`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-2 w-full mt-2">
      {/* Diff Header Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-[#101013] border border-white/[0.07] rounded-t-md text-xs">
        <div className="flex items-center gap-2 font-mono">
          <span className="text-zinc-500 font-medium">Unified Diff</span>
          {stats.files > 0 ? (
            <span className="bg-transparent text-zinc-100 border border-white/[0.07] rounded-md px-1.5 py-0.5 text-[11px]">
              {stats.files} file{stats.files === 1 ? "" : "s"}
            </span>
          ) : null}
          <span className="text-[#4cc38a] font-semibold">+{stats.additions}</span>
          <span className="text-[#f06666] font-semibold">-{stats.deletions}</span>
        </div>
        <div className="flex items-center gap-2">
          <Tooltip content={copied ? "Diff copied to clipboard!" : "Copy unified diff to clipboard"} side="top">
            <button
              type="button"
              onClick={copyDiff}
              className="text-[11px] font-sans px-2.5 py-1 rounded bg-transparent hover:bg-white/[0.06] text-zinc-100 border border-white/[0.07] transition-colors flex items-center gap-1.5"
            >
              {copied ? (
                <>
                  <svg className="w-3.5 h-3.5 text-[#4cc38a]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  <span className="text-[#4cc38a] font-medium">Copied</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  <span>Copy diff</span>
                </>
              )}
            </button>
          </Tooltip>

          <Tooltip content="Download raw git patch file" side="top">
            <button
              type="button"
              onClick={downloadPatch}
              className="text-[11px] font-sans px-2.5 py-1 rounded bg-transparent hover:bg-white/[0.06] text-zinc-500 hover:text-zinc-100 border border-white/[0.07] transition-colors flex items-center gap-1"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              <span>.diff</span>
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Code Block */}
      <pre
        className="font-mono text-[12px] leading-[1.45] bg-[#0d0d0f] border border-white/[0.07] rounded-b-md p-3.5 -mt-2 max-h-96 overflow-auto whitespace-pre block w-full"
        aria-label={runId ? `Diff for ${runId}` : "Unified diff"}
      >
        <code className="block w-full font-mono">
          {lines.map((line, index) => (
            <span key={index} className={LINE_CLASSES[classifyLine(line)]}>
              {line}
              {index < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

