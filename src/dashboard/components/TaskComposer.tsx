import { type JSX, type SyntheticEvent, useEffect, useRef } from "react";
import { Tooltip } from "./Tooltip";

export interface TaskComposerProps {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  harness: string;
  busy: boolean;
  isSubmitting: boolean;
  clearing: boolean;
  onRepoUrlChange: (value: string) => void;
  onTaskChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onPublishPullRequestChange: (value: boolean) => void;
  onHarnessChange: (value: string) => void;
  onSubmit: (event: SyntheticEvent) => void;
  onClear: () => void;
}

const HARNESS_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "opencode", label: "OpenCode", desc: "Default autonomous coding engine" },
  { value: "claude-code", label: "Claude Code", desc: "Anthropic Claude Code CLI" },
  { value: "codex", label: "Codex", desc: "Codex autonomous CLI agent" },
  { value: "devin", label: "Devin", desc: "Cognition Devin CLI (needs DEVIN_API_KEY)" },
];

export function TaskComposer({
  repoUrl,
  task,
  baseBranch,
  publishPullRequest,
  harness,
  busy,
  isSubmitting,
  clearing,
  onRepoUrlChange,
  onTaskChange,
  onBaseBranchChange,
  onPublishPullRequestChange,
  onHarnessChange,
  onSubmit,
  onClear,
}: TaskComposerProps): JSX.Element {
  const sendDisabled = busy || task.trim() === "" || repoUrl.trim() === "";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Auto-grow the task field up to ~192px, then scroll.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [task]);

  const handleSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (sendDisabled) return;
    onSubmit(event);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      handleSubmit(event);
    }
  };

  const fieldClass =
    "bg-[#0a0c10] border border-[#1e2530] rounded-lg text-[#e6edf3] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[#2dd4bf] focus:ring-1 focus:ring-[#2dd4bf]/40 placeholder-[#8b98a9]/60 transition-colors";

  const currentHarness = HARNESS_OPTIONS.find((h) => h.value === harness);

  return (
    <form
      data-testid="task-composer"
      aria-label="Task composer"
      onSubmit={handleSubmit}
      className="rounded-xl border border-[#1e2530] bg-[#0a0c10] p-3 flex flex-col gap-2.5 shadow-lg relative group focus-within:border-white/[0.18] transition-colors"
    >
      <textarea
        ref={textareaRef}
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the task or bug to fix (e.g. 'Fix the broken authentication test in auth.test.ts')…"
        rows={1}
        className="w-full resize-none bg-transparent text-sm text-[#e6edf3] placeholder-[#8b98a9]/70 focus:outline-none min-h-[72px] max-h-48 overflow-y-auto leading-relaxed"
        aria-label="Task description"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <Tooltip content="Target GitHub repository URL (cloned into container)" side="top" align="start">
          <input
            type="url"
            required
            value={repoUrl}
            onChange={(event) => onRepoUrlChange(event.target.value)}
            placeholder="github.com/owner/repo"
            aria-label="Repository URL"
            className={`${fieldClass} flex-1 min-w-[160px] font-mono`}
          />
        </Tooltip>

        <Tooltip content="Base branch to checkout" side="top">
          <input
            type="text"
            value={baseBranch}
            onChange={(event) => onBaseBranchChange(event.target.value)}
            placeholder="main"
            aria-label="Base branch"
            className={`${fieldClass} w-24 font-mono`}
          />
        </Tooltip>

        <Tooltip content={currentHarness?.desc ?? "Sandbox coding harness"} side="top">
          <select
            value={harness}
            onChange={(event) => onHarnessChange(event.target.value)}
            aria-label="Harness"
            className={`${fieldClass} cursor-pointer`}
          >
            {HARNESS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Tooltip>

        <Tooltip content="Publish branch and open Pull Request on completion" side="top">
          <label className="flex items-center gap-1.5 text-xs text-[#8b98a9] hover:text-[#e6edf3] cursor-pointer select-none px-1.5 py-1 rounded hover:bg-white/[0.04] transition-colors">
            <input
              type="checkbox"
              checked={publishPullRequest}
              onChange={(event) => onPublishPullRequestChange(event.target.checked)}
              className="accent-[#0B9F95] w-3.5 h-3.5 rounded cursor-pointer"
            />
            <span>Create PR</span>
          </label>
        </Tooltip>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-white/[0.04]">
        <span className="text-[11px] text-[#8b98a9]/80 font-mono flex items-center gap-1">
          <span className="text-teal-400/80">●</span>
          <span>approval-gated · container isolated</span>
        </span>
        <div className="flex items-center gap-2">
          <Tooltip content="Clear task description and reset inputs" side="top">
            <button
              type="button"
              onClick={onClear}
              disabled={clearing || busy}
              className="text-xs text-[#8b98a9] hover:text-[#e6edf3] bg-transparent border border-[#1e2530] hover:border-[#2c3545] font-medium py-1.5 px-3 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearing ? "Clearing…" : "Clear"}
            </button>
          </Tooltip>

          <Tooltip content="Submit task to coding sandbox agent" shortcut="⌘↵" side="top">
            <button
              type="submit"
              disabled={sendDisabled || isSubmitting}
              className="bg-[#0B9F95] hover:bg-[#2dd4bf] text-black font-semibold py-1.5 px-4 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed text-xs flex items-center gap-1.5 shadow-sm active:scale-[0.98]"
            >
              {isSubmitting ? "Sending…" : "Send"}
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
    </form>
  );
}
