import { type JSX, type SyntheticEvent } from "react";

export interface TaskComposerProps {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  harness: string;
  busy: boolean;
  submitting: boolean;
  clearing: boolean;
  onRepoUrlChange: (value: string) => void;
  onTaskChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onPublishPullRequestChange: (value: boolean) => void;
  onHarnessChange: (value: string) => void;
  onSubmit: (event: SyntheticEvent) => void;
  onClear: () => void;
}

const HARNESS_OPTIONS: { value: string; label: string }[] = [
  { value: "opencode", label: "OpenCode" },
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "Codex" },
];

// Devin-style composer pinned to the bottom of the conversation timeline.
// All fields are controlled via props — same semantics as TaskForm.
export function TaskComposer({
  repoUrl,
  task,
  baseBranch,
  publishPullRequest,
  harness,
  busy,
  submitting,
  clearing,
  onRepoUrlChange,
  onTaskChange,
  onBaseBranchChange,
  onPublishPullRequestChange,
  onHarnessChange,
  onSubmit,
  onClear,
}: TaskComposerProps): JSX.Element {
  const sendDisabled = busy || task.trim() === "";

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
    "bg-[#0a0c10] border border-[#1e2530] rounded-lg text-[#e6edf3] px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[#2dd4bf] focus:ring-offset-2 focus:ring-offset-black placeholder-[#8b98a9]/60 transition-colors";

  return (
    <form
      data-testid="task-composer"
      aria-label="Task composer"
      onSubmit={handleSubmit}
      className="rounded-xl border border-[#1e2530] bg-[#0a0c10] p-3 flex flex-col gap-2.5 shadow-lg"
    >
      <textarea
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the change you want…"
        rows={3}
        className="w-full resize-none bg-transparent text-sm text-[#e6edf3] placeholder-[#8b98a9]/70 focus:outline-none min-h-[72px] max-h-48 overflow-y-auto leading-relaxed"
        aria-label="Task description"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <input
          type="text"
          value={repoUrl}
          onChange={(event) => onRepoUrlChange(event.target.value)}
          placeholder="github.com/owner/repo"
          aria-label="Repository URL"
          className={`${fieldClass} flex-1 min-w-[160px] font-mono`}
        />
        <input
          type="text"
          value={baseBranch}
          onChange={(event) => onBaseBranchChange(event.target.value)}
          placeholder="main"
          aria-label="Base branch"
          className={`${fieldClass} w-24 font-mono`}
        />
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
        <label className="flex items-center gap-1.5 text-xs text-[#8b98a9] cursor-pointer select-none">
          <input
            type="checkbox"
            checked={publishPullRequest}
            onChange={(event) => onPublishPullRequestChange(event.target.checked)}
            className="accent-[#0B9F95] w-3.5 h-3.5"
          />
          PR
        </label>
      </div>

      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-[#8b98a9]/80 font-mono">
          ⌘+Enter to submit · approval gate on
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onClear}
            disabled={clearing || busy}
            className="text-xs text-[#8b98a9] hover:text-[#e6edf3] bg-transparent border border-[#1e2530] hover:border-[#2c3545] font-medium py-1.5 px-3 rounded-lg transition-colors disabled:opacity-50"
          >
            {clearing ? "Clearing…" : "Clear"}
          </button>
          <button
            type="submit"
            disabled={sendDisabled}
            className="bg-[#0B9F95] hover:bg-[#2dd4bf] text-black font-semibold py-1.5 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs flex items-center gap-1.5"
          >
            {submitting ? "Sending…" : "Send"}
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M13 6l6 6-6 6" />
            </svg>
          </button>
        </div>
      </div>
    </form>
  );
}
