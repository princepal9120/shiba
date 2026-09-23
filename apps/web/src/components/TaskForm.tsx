import { createElement, type SyntheticEvent } from "react";

export interface TaskFormProps {
  repoUrl?: string;
  task?: string;
  baseBranch?: string;
  publishPullRequest?: boolean;
  harness?: string;
  busy?: boolean;
  submitting?: boolean;
  clearing?: boolean;
  onRepoUrlChange?: (value: string) => void;
  onTaskChange?: (value: string) => void;
  onBaseBranchChange?: (value: string) => void;
  onPublishPullRequestChange?: (value: boolean) => void;
  onHarnessChange?: (value: string) => void;
  onSubmit?: (event: SyntheticEvent) => void;
  onClear?: () => void;
}

const HARNESS_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: "opencode", label: "OpenCode (default)", hint: "Google / Anthropic / OpenAI models" },
  { value: "claude-code", label: "Claude Code", hint: "Anthropic models — needs the gateway's Anthropic key" },
  { value: "codex", label: "Codex", hint: "OpenAI models — needs the gateway's OpenAI key" },
];

// Built with createElement (no JSX): the Astro tsconfig covering web/
// preserves JSX, which the root vitest transform cannot parse here.
export function TaskForm({
  repoUrl = "",
  task = "",
  baseBranch = "main",
  publishPullRequest = false,
  harness = "opencode",
  busy = false,
  submitting = false,
  clearing = false,
  onRepoUrlChange,
  onTaskChange,
  onBaseBranchChange,
  onPublishPullRequestChange,
  onHarnessChange,
  onSubmit,
  onClear,
}: TaskFormProps = {}) {
  const inputClass = "bg-[#0f1419] border border-[#2a3441] rounded-lg text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#4f9cf0] placeholder-gray-600 w-full";
  const labelClass = "text-sm font-medium text-gray-400";
  const buttonPrimary = "bg-[#4f9cf0] hover:bg-[#3b82f6] text-[#06121f] font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm";
  const buttonSecondary = "bg-transparent border border-[#2a3441] hover:bg-[#2a3441] text-gray-300 font-semibold py-2 px-4 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm";

  return createElement(
    "form",
    {
      "data-testid": "task-submission-form",
      "aria-label": "Task submission form",
      onSubmit: onSubmit ?? ((event: SyntheticEvent) => event.preventDefault()),
      className: "flex flex-col gap-4",
    },
    createElement(
      "label",
      { className: "flex flex-col gap-1.5" },
      createElement("span", { className: labelClass }, "Repository URL"),
      createElement("input", {
        type: "url",
        inputMode: "url",
        required: true,
        name: "repoUrl",
        placeholder: "https://github.com/owner/repo",
        value: repoUrl,
        className: inputClass,
        onChange: (event: { target: { value: string } }) =>
          onRepoUrlChange?.(event.target.value),
      }),
    ),
    createElement(
      "label",
      { className: "flex flex-col gap-1.5" },
      createElement("span", { className: labelClass }, "Base branch"),
      createElement("input", {
        type: "text",
        name: "baseBranch",
        value: baseBranch,
        className: inputClass,
        onChange: (event: { target: { value: string } }) =>
          onBaseBranchChange?.(event.target.value),
        placeholder: "main",
      }),
    ),
    createElement(
      "label",
      { className: "flex flex-col gap-1.5" },
      createElement("span", { className: labelClass }, "Task"),
      createElement("textarea", {
        required: true,
        name: "task",
        rows: 5,
        placeholder:
          "Describe the change you want, e.g. fix the login redirect and add a test.",
        value: task,
        className: inputClass + " resize-y",
        onChange: (event: { target: { value: string } }) =>
          onTaskChange?.(event.target.value),
      }),
    ),
    createElement(
      "label",
      { className: "flex flex-col gap-1.5" },
      createElement("span", { className: labelClass }, "Coding agent"),
      createElement(
        "select",
        {
          name: "harness",
          value: harness,
          className: inputClass,
          onChange: (event: { target: { value: string } }) =>
            onHarnessChange?.(event.target.value),
        },
        ...HARNESS_OPTIONS.map((option) =>
          createElement("option", { key: option.value, value: option.value }, option.label),
        ),
      ),
      createElement(
        "span",
        { className: "text-xs text-gray-500" },
        HARNESS_OPTIONS.find((option) => option.value === harness)?.hint ?? "",
      ),
    ),
    createElement(
      "label",
      { className: "flex items-start gap-2 mt-1 cursor-pointer" },
      createElement("input", {
        type: "checkbox",
        name: "publishPullRequest",
        checked: publishPullRequest,
        className: "mt-0.5 h-4 w-4 rounded border-gray-600 bg-[#0f1419] text-[#4f9cf0] focus:ring-[#4f9cf0] focus:ring-offset-[#182028]",
        onChange: (event: { target: { checked: boolean } }) =>
          onPublishPullRequestChange?.(event.target.checked),
      }),
      createElement(
        "span",
        { className: "text-sm text-gray-400 select-none" },
        "Open a pull request with the result (requires GITHUB_TOKEN)",
      ),
    ),
    createElement(
      "div",
      { className: "flex flex-wrap gap-3 mt-2" },
      createElement(
        "button",
        { type: "submit", disabled: busy, className: buttonPrimary },
        submitting ? "Submitting..." : busy ? "Working..." : "Send for approval",
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: onClear,
          className: buttonSecondary,
          disabled: busy,
        },
        clearing ? "Clearing history..." : "Clear history",
      ),
    ),
  );
}
