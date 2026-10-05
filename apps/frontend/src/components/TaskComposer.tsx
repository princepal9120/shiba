import { type JSX, type SyntheticEvent, useEffect, useRef } from "react";
import { Tooltip } from "./Tooltip";
import type { SavedSkill } from "../saved";

export interface TaskComposerProps {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  harness: string;
  codingModel: string;
  connectionId: string;
  busy: boolean;
  isSubmitting: boolean;
  clearing: boolean;
  onRepoUrlChange: (value: string) => void;
  onTaskChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onPublishPullRequestChange: (value: boolean) => void;
  onHarnessChange: (value: string) => void;
  onCodingModelChange: (value: string) => void;
  onConnectionChange: (value: string) => void;
  onSubmit: (event: SyntheticEvent) => void;
  onClear: () => void;
  /** Saved repos + run-history repos for the URL picker. */
  repoSuggestions?: string[];
  /** Your saved skills — toggle them onto the run. */
  skills?: SavedSkill[];
  selectedSkillIds?: string[];
  onToggleSkill?: (id: string) => void;
  /** Coding-purpose models from /api/model-config (the "auto" floor plus registered connections). */
  modelSuggestions?: string[];
  connections?: { id: string; label: string; status: string }[];
  /** "docked" = compact bar under the timeline; "hero" = centered empty-state card. */
  variant?: "docked" | "hero";
}

const HARNESS_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "opencode", label: "OpenCode", desc: "Default autonomous coding engine" },
  { value: "claude-code", label: "Claude Code", desc: "Anthropic Claude Code CLI" },
  { value: "claude-acp", label: "Claude Agent (ACP)", desc: "Claude via the Agent Client Protocol adapter" },
  { value: "claude-subscription", label: "Claude (subscription)", desc: "Your Claude plan (needs SHIBA_CLAUDE_SUBSCRIPTION)" },
  { value: "codex", label: "Codex", desc: "Codex autonomous CLI agent" },
  { value: "codex-acp", label: "Codex (ACP)", desc: "Codex via the Agent Client Protocol adapter" },
  { value: "codex-subscription", label: "Codex (subscription)", desc: "Your ChatGPT plan (needs SHIBA_CODEX_SUBSCRIPTION)" },
  { value: "gemini-acp", label: "Gemini CLI (ACP)", desc: "Google Gemini CLI speaking ACP" },
  { value: "opencode-acp", label: "OpenCode (ACP)", desc: "OpenCode's `acp` subcommand" },
  { value: "devin", label: "Devin", desc: "Cognition Devin CLI (needs DEVIN_API_KEY)" },
  { value: "devin-acp", label: "Devin (ACP)", desc: "Devin CLI speaking ACP (needs DEVIN_API_KEY)" },
  { value: "devin-subscription", label: "Devin (subscription)", desc: "Your Devin plan (needs SHIBA_DEVIN_SUBSCRIPTION)" },
  { value: "grok", label: "Grok", desc: "xAI Grok CLI (AI Gateway BYOK)" },
  { value: "antigravity-subscription", label: "Antigravity (subscription)", desc: "Your Google plan (needs SHIBA_ANTIGRAVITY_SUBSCRIPTION)" },
  { value: "cursor-subscription", label: "Cursor (subscription)", desc: "Your Cursor plan (needs SHIBA_CURSOR_SUBSCRIPTION)" },
];

export function TaskComposer({
  repoUrl,
  task,
  baseBranch,
  publishPullRequest,
  harness,
  codingModel,
  connectionId,
  busy,
  isSubmitting,
  clearing,
  onRepoUrlChange,
  onTaskChange,
  onBaseBranchChange,
  onPublishPullRequestChange,
  onHarnessChange,
  onCodingModelChange,
  onConnectionChange,
  onSubmit,
  onClear,
  repoSuggestions = [],
  skills = [],
  selectedSkillIds = [],
  onToggleSkill,
  modelSuggestions = [],
  connections = [],
  variant = "docked",
}: TaskComposerProps): JSX.Element {
  const sendDisabled = busy || task.trim() === "" || repoUrl.trim() === "";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hero = variant === "hero";

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
    "bg-[#f1efe6] border border-[#e0ded5] rounded-none text-[#222320] px-2.5 py-1.5 touch:min-h-11 text-xs focus:outline-none focus:border-[#1c1cc8] focus:ring-1 focus:ring-[#1c1cc8]/40 placeholder-[#6a6f63]/60 transition-colors";

  const currentHarness = HARNESS_OPTIONS.find((h) => h.value === harness);
  const currentConnection = connections.find((c) => c.id === connectionId);

  const form = (
    <form
      data-testid="task-composer"
      aria-label="Task composer"
      onSubmit={handleSubmit}
      className={`rounded-none border bg-[#fffef8] flex flex-col shadow-[3px_3px_0_var(--paper-shadow)] relative group focus-within:border-[#0000a8]/40 transition-colors ${
        hero ? "border-[#c9c8bc] p-4 sm:p-5 gap-3" : "border-[#d3d2c8] p-3 gap-2.5"
      }`}
    >
      <textarea
        ref={textareaRef}
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the task or bug to fix (e.g. 'Fix the broken authentication test in auth.test.ts')…"
        rows={1}
        className={`w-full resize-none bg-transparent text-base lg:text-sm text-[#222320] placeholder-[#6a6f63]/70 focus:outline-none overflow-y-auto leading-relaxed ${
          hero ? "min-h-[96px] max-h-64" : "min-h-[72px] max-h-48"
        }`}
        aria-label="Task description"
      />

      <div className="flex items-center gap-2 flex-wrap">
        <Tooltip content="Target GitHub repository URL (cloned into container)" side="top" align="start">
          <input
            type="url"
            required
            list="shiba-saved-repos"
            value={repoUrl}
            onChange={(event) => onRepoUrlChange(event.target.value)}
            placeholder="github.com/owner/repo"
            aria-label="Repository URL"
            className={`${fieldClass} flex-1 min-w-[160px] font-mono`}
          />
          {repoSuggestions.length > 0 ? (
            <datalist id="shiba-saved-repos">
              {repoSuggestions.map((repo) => (
                <option key={repo} value={repo} />
              ))}
            </datalist>
          ) : null}
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

        <Tooltip content="Model the coding agent uses — leave blank for the deployment default" side="top">
          <input
            type="text"
            list="shiba-coding-models"
            value={codingModel}
            onChange={(event) => onCodingModelChange(event.target.value)}
            placeholder="model (auto)"
            aria-label="Coding model"
            className={`${fieldClass} w-36 font-mono`}
          />
          {modelSuggestions.length > 0 ? (
            <datalist id="shiba-coding-models">
              {modelSuggestions.map((model) => (
                <option key={model} value={model} />
              ))}
            </datalist>
          ) : null}
        </Tooltip>

        {connections.length > 0 ? (
          <Tooltip content={currentConnection ? `Model connection — ${currentConnection.status}` : "Model connection (auto route)"} side="top">
            <select
              value={connectionId}
              onChange={(event) => onConnectionChange(event.target.value)}
              aria-label="Model connection"
              className={`${fieldClass} cursor-pointer`}
            >
              <option value="">auto route</option>
              {connections.map((connection) => (
                <option key={connection.id} value={connection.id}>
                  {connection.label}
                </option>
              ))}
            </select>
          </Tooltip>
        ) : null}

        <Tooltip content="Publish branch and open Pull Request on completion" side="top">
          <label className="flex items-center gap-1.5 text-xs text-[#6a6f63] hover:text-[#222320] cursor-pointer select-none px-1.5 py-1 touch:min-h-11 rounded-none hover:bg-black/[0.04] transition-colors">
            <input
              type="checkbox"
              checked={publishPullRequest}
              onChange={(event) => onPublishPullRequestChange(event.target.checked)}
              className="accent-[#0000a8] w-3.5 h-3.5 rounded-none cursor-pointer"
            />
            <span>Create PR</span>
          </label>
        </Tooltip>
      </div>

      {skills.length > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label="Attach saved skills">
          <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[#6a6f63] mr-1">
            Skills
          </span>
          {skills.map((skill) => {
            const active = selectedSkillIds.includes(skill.id);
            return (
              <button
                key={skill.id}
                type="button"
                aria-pressed={active}
                onClick={() => onToggleSkill?.(skill.id)}
                className={`text-[10px] font-medium px-2 py-1 rounded-none border transition-colors ${
                  active
                    ? "bg-[#0000a8]/10 border-[#0000a8]/30 text-[#1c1cc8]"
                    : "bg-transparent border-[#e0ded5] text-[#6a6f63] hover:border-[#0000a8]/30 hover:text-[#222320]"
                }`}
              >
                {skill.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-1 border-t border-black/[0.04]">
        <span className="min-w-0 text-[11px] text-[#6a6f63]/80 font-mono flex items-center gap-1">
          <span className="text-[#0000a8]/80">●</span>
          <span className="truncate">approval-gated · container isolated</span>
        </span>
        <div className="flex items-center gap-2 shrink-0">
          <Tooltip content="Clear task description and reset inputs" side="top">
            <button
              type="button"
              onClick={onClear}
              disabled={clearing || busy}
              className="text-xs text-[#6a6f63] hover:text-[#222320] bg-transparent border border-[#e0ded5] hover:border-[#d3d2c8] font-medium py-1.5 px-3 touch:min-h-11 rounded-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearing ? "Clearing…" : "Clear"}
            </button>
          </Tooltip>

          <Tooltip content="Submit task to coding sandbox agent" shortcut="⌘↵" side="top">
            <button
              type="submit"
              disabled={sendDisabled || isSubmitting}
              className="bg-[#0000a8] hover:bg-[#1c1cc8] text-white font-semibold py-1.5 px-4 touch:min-h-11 touch:px-5 rounded-none transition-all disabled:opacity-40 disabled:cursor-not-allowed text-xs flex items-center gap-1.5 shadow-[2px_2px_0_var(--paper-shadow)] active:translate-y-px"
            >
              {isSubmitting ? "Sending…" : "Send"}
              <svg aria-hidden="true"  className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </button>
          </Tooltip>
        </div>
      </div>
    </form>
  );

  if (!hero) return form;

  const repoSlug = repoUrl.trim().split("/").slice(-2).join("/") || "your repo";
  return (
    <div className="flex-1 flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-2xl flex flex-col items-center gap-6">
        <div className="text-center">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-[#222320]">
            What should we build?
          </h1>
          <p className="mt-2 text-sm text-[#6a6f63]">
            Describe the task — your agent works in an isolated sandbox against{" "}
            <span className="font-mono text-xs">{repoSlug}</span> and opens a PR when it's done.
          </p>
        </div>
        {form}
        <p className="text-[11px] text-[#6a6f63]/80 font-mono">
          approval-gated · container isolated · everything lands in Activity
        </p>
      </div>
    </div>
  );
}
