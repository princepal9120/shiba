
import {
  type JSX,
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  Cloud,
  Container,
  Cpu,
  Eraser,
  FolderGit2,
  Gauge,
  GitBranch,
  GitPullRequest,
  Home,
  Laptop,
  Lock,
  Mic,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Tooltip } from "./Tooltip";
import type { SavedSkill } from "../saved";
import { HARNESS_REASONING_EFFORTS, type ReasoningEffort } from "@shiba/shared";

// Ambient types for browser Web Speech API.
interface SpeechRecognitionResultItem {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal?: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultItem;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionInstance {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

interface WindowWithSpeech {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

function getSpeechRecognitionClass(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const win = window as unknown as WindowWithSpeech;
  return win.SpeechRecognition ?? win.webkitSpeechRecognition ?? null;
}

/** Model-by-purpose routing controls — the picker's values and its option lists. */
export interface ModelRoutingControl {
  codingModel: string;
  connectionId: string;
  onCodingModelChange: (value: string) => void;
  onConnectionChange: (value: string) => void;
  reasoningEffort: ReasoningEffort | "";
  onReasoningEffortChange: (value: ReasoningEffort | "") => void;
  /** Coding-purpose models from /api/model-config (the "auto" floor plus registered connections). */
  modelSuggestions?: string[];
  connections?: { id: string; label: string; status: string; service?: string }[];
}

export interface TaskComposerProps {
  repoUrl: string;
  task: string;
  baseBranch: string;
  publishPullRequest: boolean;
  reviewAfterPublish?: boolean;
  runSetup?: boolean;
  onRunSetupChange?: (value: boolean) => void;
  harness: string;
  /** T63 — desktop "Run on" control. Rendered only when the shell reports a
   *  paired, ready daemon (localRunAvailable). "sandbox" keeps the chat path. */
  runTarget?: "sandbox" | "local";
  onRunTargetChange?: (value: "sandbox" | "local") => void;
  localRunAvailable?: boolean;
  routing: ModelRoutingControl;
  busy: boolean;
  isSubmitting: boolean;
  clearing: boolean;
  onRepoUrlChange: (value: string) => void;
  onTaskChange: (value: string) => void;
  onBaseBranchChange: (value: string) => void;
  onPublishPullRequestChange: (value: boolean) => void;
  onReviewAfterPublishChange?: (value: boolean) => void;
  onHarnessChange: (value: string) => void;
  onSubmit: (event: SyntheticEvent) => void;
  onClear: () => void;
  /** Saved repos + run-history repos for the URL picker. */
  repoSuggestions?: string[];
  /** Your saved skills — toggle them onto the run. */
  skills?: SavedSkill[];
  selectedSkillIds?: string[];
  onToggleSkill?: (id: string) => void;
  /** Org custom agents from /api/custom-agents */
  customAgents?: { id: string; name: string; slug: string; emoji?: string }[];
  customAgentId?: string;
  onCustomAgentChange?: (id: string) => void;
  /** "docked" = compact bar under the timeline; "hero" = centered empty-state card. */
  variant?: "docked" | "hero";
  /** Optional per-run environment variables */
  envVars?: { name: string; value: string }[];
  onEnvVarsChange?: (vars: { name: string; value: string }[]) => void;
}

// Keep the picker simple: the everyday harnesses plus Pi. Everything else stays
// reachable — a deployment default, role pin, MCP, or API call naming codex /
// devin / a subscription / an ACP lane still resolves and runs; when such a
// harness is already selected it is appended to the list so the field never
// renders blank.
const HARNESS_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "opencode", label: "OpenCode", desc: "Default autonomous coding engine" },
  { value: "claude-code", label: "Claude Code", desc: "Anthropic Claude Code CLI" },
  {
    value: "codex-subscription",
    label: "Codex (ChatGPT plan)",
    desc: "Your ChatGPT subscription — no AI Gateway token",
  },
  {
    value: "claude-subscription",
    label: "Claude (setup-token)",
    desc: "Opt-in setup-token. Prefer Local + Claude Code",
  },
  { value: "pi", label: "Pi", desc: "Earendil Pi agent — Anthropic, OpenAI, Google, xAI" },
];

// Only these harnesses declare local support — the backend refuses anything
// else at intake (orchestrator.ts), so the local lane pins to this set.
const LOCAL_HARNESS_OPTIONS: { value: string; label: string; desc: string }[] = [
  { value: "opencode", label: "OpenCode", desc: "Default autonomous coding engine" },
  { value: "claude-code", label: "Claude Code", desc: "Anthropic Claude Code CLI" },
  { value: "codex", label: "Codex", desc: "OpenAI Codex CLI" },
];

type PopoverKind = "menu" | "repo" | "branch" | "harness" | "model" | "effort" | "access" | "config" | "env" | null;

function formatEffort(level: string): string {
  return level ? level.charAt(0).toUpperCase() + level.slice(1) : "";
}

/** owner/repo from a GitHub URL; falls back to the trimmed raw value. */
function repoSlugOf(repoUrl: string): string {
  const clean = repoUrl
    .trim()
    .replace(/\/git$/, "")
    .replace(/\.git$/, "");
  const parts = clean.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : clean;
}

/** provider/model → the model tail shown on the pill (provider stays visible in the menu). */
function modelTail(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(slash + 1) : model;
}

function AnthropicIcon({ className = "size-3.5" }: { className?: string }): JSX.Element {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

/**
 * One popover surface anchored to its trigger. Panels open upward — the
 * composer docks at the viewport bottom, so a downward menu would clip.
 * Closes on Escape and on any pointerdown outside its wrapper.
 */
function Popover({
  kind,
  open,
  onClose,
  labelledBy,
  className = "",
  children,
}: {
  kind: Exclude<PopoverKind, null>;
  open: boolean;
  onClose: () => void;
  labelledBy: string;
  className?: string;
  children: ReactNode;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="menu"
      aria-labelledby={labelledBy}
      data-popover={kind}
      className={`absolute bottom-full mb-1.5 z-40 bg-[var(--popover)] border border-[var(--border-1)] rounded-[var(--radius-overlay)] shadow-[var(--sh-overlay)] overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

const pillClass =
  "inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] border border-transparent hover:border-[var(--border-1)] px-2 py-1.5 h-[var(--h-control-sm,28px)] rounded-[var(--radius-button)] transition-colors cursor-pointer select-none max-w-[220px]";
const pillLabelClass = "truncate font-medium";
const menuRowClass =
  "w-full flex items-center gap-2.5 px-3 py-1.5 text-left text-xs text-[var(--fg)] hover:bg-[var(--secondary-hover)] transition-colors cursor-pointer";
const menuIconClass = "size-3.5 text-[var(--icon-muted)] shrink-0";
const menuCheckClass = "size-3.5 text-[var(--primary)] shrink-0";
const sectionLabelClass =
  "text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground-2)]";
const inputClass =
  "bg-[var(--input)] border border-[var(--border-1)] rounded-[var(--radius-sm)] text-[var(--fg)] px-2.5 py-1.5 text-xs focus:outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] placeholder-[var(--muted-foreground-3)] transition-colors";

export function TaskComposer({
  repoUrl,
  task,
  baseBranch,
  publishPullRequest,
  reviewAfterPublish = false,
  runSetup = false,
  harness,
  runTarget = "sandbox",
  onRunTargetChange,
  localRunAvailable = false,
  routing,
  busy,
  isSubmitting,
  clearing,
  onRepoUrlChange,
  onTaskChange,
  onBaseBranchChange,
  onPublishPullRequestChange,
  onReviewAfterPublishChange,
  onRunSetupChange,
  onHarnessChange,
  onSubmit,
  onClear,
  repoSuggestions = [],
  skills = [],
  selectedSkillIds = [],
  onToggleSkill,
  customAgents = [],
  customAgentId = "",
  onCustomAgentChange,
  variant = "docked",
  envVars = [],
  onEnvVarsChange,
}: TaskComposerProps): JSX.Element {
  const sendDisabled = busy || task.trim() === "" || repoUrl.trim() === "";
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hero = variant === "hero";

  const [open, setOpen] = useState<PopoverKind>(null);
  const [menuView, setMenuView] = useState<"root" | "skills">("root");
  const [repoFilter, setRepoFilter] = useState("");
  const [repoUrlDraft, setRepoUrlDraft] = useState("");
  const [modelFilter, setModelFilter] = useState("");
  const [modelDraft, setModelDraft] = useState("");
  const [branchDraft, setBranchDraft] = useState("");
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const baseId = useId();
  const idFor = (name: string) => `${baseId}-${name}`;

  // T87 — voice dictation via Web Speech API.
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const taskRef = useRef(task);
  taskRef.current = task;
  const onTaskChangeRef = useRef(onTaskChange);
  onTaskChangeRef.current = onTaskChange;

  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop();
      } catch {
        // Recognition already stopped
      }
      recognitionRef.current = null;
    }
    setListening(false);
  }, []);

  const toggleListening = useCallback(() => {
    if (listening) {
      stopListening();
      return;
    }
    const SpeechClass = getSpeechRecognitionClass();
    if (!SpeechClass) return;

    try {
      const recognition = new SpeechClass();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang =
        typeof navigator !== "undefined" && navigator.language
          ? navigator.language
          : "en-US";

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let transcript = "";
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result && (result.isFinal === undefined || result.isFinal)) {
            const item = result[0];
            if (item?.transcript) {
              transcript += item.transcript;
            }
          }
        }
        const text = transcript.trim();
        if (!text) return;
        const currentTask = taskRef.current;
        const nextTask = currentTask.trimEnd() ? `${currentTask.trimEnd()} ${text}` : text;
        onTaskChangeRef.current(nextTask);
      };

      recognition.onerror = () => {
        stopListening();
      };

      recognition.onend = () => {
        setListening(false);
        recognitionRef.current = null;
      };

      recognitionRef.current = recognition;
      recognition.start();
      setListening(true);
    } catch {
      stopListening();
    }
  }, [listening, stopListening]);

  useEffect(() => {
    return () => {
      stopListening();
    };
  }, [stopListening]);

  useEffect(() => {
    if (isSubmitting) {
      stopListening();
    }
  }, [isSubmitting, stopListening]);

  const handleAddEnvVar = () => {
    if (!draftName.trim() && !draftValue) return;
    const next = [...envVars, { name: draftName.trim(), value: draftValue }];
    onEnvVarsChange?.(next);
    setDraftName("");
    setDraftValue("");
  };

  const handleUpdateEnvVar = (index: number, field: "name" | "value", val: string) => {
    const target = envVars[index];
    if (!target) return;
    const next = [...envVars];
    next[index] = {
      name: field === "name" ? val : target.name,
      value: field === "value" ? val : target.value,
    };
    onEnvVarsChange?.(next);
  };

  const handleRemoveEnvVar = (index: number) => {
    const next = envVars.filter((_, i) => i !== index);
    onEnvVarsChange?.(next);
  };

  const toggle = useCallback(
    (kind: Exclude<PopoverKind, null>) => {
      setOpen((current) => {
        const next = current === kind ? null : kind;
        if (next !== null) {
          if (next !== "menu") setMenuView("root");
          if (next === "repo") {
            setRepoFilter("");
            setRepoUrlDraft(repoUrl.startsWith("https://") ? "" : repoUrl);
          }
          if (next === "model") {
            setModelFilter("");
            setModelDraft("");
          }
          if (next === "branch" || next === "config") {
            setBranchDraft(baseBranch);
          }
        }
        return next;
      });
    },
    [repoUrl, baseBranch],
  );
  const close = useCallback(() => setOpen(null), []);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  });

  const handleSubmit = (event: SyntheticEvent) => {
    event.preventDefault();
    if (sendDisabled) return;
    setOpen(null);
    stopListening();
    onSubmit(event);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      handleSubmit(event);
    }
  };

  const harnessBase = runTarget === "local" ? LOCAL_HARNESS_OPTIONS : HARNESS_OPTIONS;
  const harnessOptions =
    harness !== "" && !harnessBase.some((h) => h.value === harness)
      ? [...harnessBase, { value: harness, label: harness, desc: "Deployment-pinned harness" }]
      : harnessBase;
  const currentHarness = harnessOptions.find((h) => h.value === harness);
  const connections = routing.connections ?? [];
  const currentConnection = connections.find((c) => c.id === routing.connectionId);
  const modelSuggestions = routing.modelSuggestions ?? [];
  const supportedEfforts = HARNESS_REASONING_EFFORTS[harness];
  const selectedEffort =
    routing.reasoningEffort && supportedEfforts?.includes(routing.reasoningEffort)
      ? routing.reasoningEffort
      : "";

  const repoSlug = repoSlugOf(repoUrl);
  const repoFilterLower = repoFilter.trim().toLowerCase();
  const filteredRepos = repoSuggestions.filter((repo) =>
    repoFilterLower === "" ? true : repo.toLowerCase().includes(repoFilterLower),
  );
  const modelFilterLower = modelFilter.trim().toLowerCase();
  const filteredModels = modelSuggestions.filter((model) =>
    modelFilterLower === "" ? true : model.toLowerCase().includes(modelFilterLower),
  );
  const modelKnown = routing.codingModel === "" || modelSuggestions.includes(routing.codingModel);
  const selectedSkills = skills.filter((skill) => selectedSkillIds.includes(skill.id));
  const selectedCustomAgent = customAgents.find((agent) => agent.id === customAgentId);
  const namedEnvVars = envVars.filter((v) => v.name.trim() !== "");
  const namedEnvCount = namedEnvVars.length;

  const pickRepo = (url: string) => {
    onRepoUrlChange(url);
    setOpen(null);
  };
  const applyBranch = () => {
    onBaseBranchChange(branchDraft.trim() || "main");
    setOpen(null);
  };
  const applyCustomModel = () => {
    const next = modelDraft.trim();
    if (next) routing.onCodingModelChange(next);
    setOpen(null);
  };

  const chevron = (
    <ChevronDown aria-hidden="true" className="size-3 text-[var(--icon-muted)] shrink-0" />
  );

  const form = (
    <form
      data-testid="task-composer"
      aria-label="Task composer"
      onSubmit={handleSubmit}
      className={`w-full rounded-[var(--radius-panel)] border border-[var(--border-1)] bg-[var(--card)] flex flex-col shadow-[var(--sh-composer)] relative group focus-within:border-[var(--ring)] transition-colors ${
        hero ? "p-4 sm:p-5 gap-3" : "p-3 gap-2.5"
      }`}
    >
      {/* Top Chips Row: Project (Repo) + Run Target */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {/* Project Selector (Home / Repo Picker) */}
        <div className="relative">
          <Tooltip content="Target GitHub repository (Project)" side="top">
            <button
              type="button"
              id={idFor("repo-button")}
              aria-haspopup="menu"
              aria-expanded={open === "repo"}
              aria-label={`Project: ${repoSlug || "Select repository"}`}
              onClick={() => toggle("repo")}
              className={`${pillClass} bg-[var(--secondary)] hover:bg-[var(--secondary-hover)] font-sans text-[var(--fg)]`}
            >
              <Home aria-hidden="true" className="size-3.5 shrink-0 text-[var(--icon-muted)]" />
              <span className={pillLabelClass}>{repoSlug || "Repository"}{repoUrl ? <span className="sr-only"> ({repoUrl})</span> : null}</span>
              {chevron}
            </button>
          </Tooltip>
          <Popover
            kind="repo"
            open={open === "repo"}
            onClose={close}
            labelledBy={idFor("repo-button")}
            className="left-0 w-72"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-1)]">
              <Search aria-hidden="true" className="size-3.5 text-[var(--icon-muted)]" />
              <input
                type="text"
                value={repoFilter}
                onChange={(event) => setRepoFilter(event.target.value)}
                placeholder="Search repositories…"
                aria-label="Search repositories"
                className="flex-1 bg-transparent text-xs text-[var(--fg)] placeholder-[var(--muted-foreground-3)] focus:outline-none"
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {filteredRepos.length === 0 ? (
                <p className="px-3 py-2.5 text-[11px] text-[var(--muted-foreground-2)]">
                  {repoSuggestions.length === 0
                    ? "No repositories yet — run one or paste a URL below."
                    : "No matches."}
                </p>
              ) : (
                filteredRepos.map((repo) => {
                  const slug = repoSlugOf(repo);
                  const active = repo === repoUrl;
                  return (
                    <button
                      key={repo}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`${menuRowClass} font-mono`}
                      onClick={() => pickRepo(repo)}
                    >
                      <FolderGit2 aria-hidden="true" className={menuIconClass} />
                      <span className="flex-1 truncate">{slug}</span>
                      {active ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
                    </button>
                  );
                })
              )}
            </div>
            <div className="border-t border-[var(--border-1)] px-3 py-2.5 flex flex-col gap-2">
              <label htmlFor={idFor("repo-url-input")} className={sectionLabelClass}>
                Use a URL
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={idFor("repo-url-input")}
                  type="url"
                  value={repoUrlDraft}
                  onChange={(event) => setRepoUrlDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && repoUrlDraft.trim()) {
                      event.preventDefault();
                      pickRepo(repoUrlDraft.trim());
                    }
                  }}
                  placeholder="https://github.com/owner/repo"
                  className={`${inputClass} flex-1 font-mono`}
                />
                <button
                  type="button"
                  disabled={!repoUrlDraft.trim()}
                  onClick={() => pickRepo(repoUrlDraft.trim())}
                  className="text-xs font-medium px-2 py-1.5 border border-[var(--border-1)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] rounded-[var(--radius-button)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Use
                </button>
              </div>
            </div>
          </Popover>
        </div>

        {/* Run Target Selector (Cloud / This computer) */}
        {onRunTargetChange ? (
          <div className="relative">
            <Tooltip content="Execution target (Cloud vs Local)" side="top">
              <button
                type="button"
                id={idFor("access-button")}
                aria-haspopup="menu"
                aria-expanded={open === "access"}
                aria-label={`Run on: ${runTarget === "local" ? "Local" : "Cloud"}`}
                onClick={() => toggle("access")}
                className={`${pillClass} bg-[var(--secondary)] hover:bg-[var(--secondary-hover)] font-sans text-[var(--fg)]`}
              >
                {runTarget === "local" ? (
                  <Laptop aria-hidden="true" className="size-3.5 shrink-0 text-[var(--icon-muted)]" />
                ) : (
                  <Cloud aria-hidden="true" className="size-3.5 shrink-0 text-[var(--icon-muted)]" />
                )}
                <span className={pillLabelClass}>
                  {runTarget === "local" ? "Local" : "Cloud"}
                </span>
                {chevron}
              </button>
            </Tooltip>
            <Popover
              kind="access"
              open={open === "access"}
              onClose={close}
              labelledBy={idFor("access-button")}
              className="left-0 w-64"
            >
              <div className="py-1">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={runTarget === "sandbox"}
                  className={menuRowClass}
                  onClick={() => {
                    onRunTargetChange("sandbox");
                    setOpen(null);
                  }}
                >
                  <Cloud aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">Cloud (Sandbox)</span>
                    <span className="block text-[10px] text-[var(--muted-foreground-2)]">
                      Isolated ephemeral Cloudflare Workers container
                    </span>
                  </span>
                  {runTarget === "sandbox" ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={runTarget === "local"}
                  className={menuRowClass}
                  onClick={() => {
                    onRunTargetChange("local");
                    setOpen(null);
                  }}
                >
                  <Laptop aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1 min-w-0">
                    <span className="block font-medium">Local (This computer)</span>
                    <span className="block text-[10px] text-[var(--muted-foreground-2)]">
                      {localRunAvailable
                        ? "Paired daemon runs the harness locally"
                        : "Pair a computer in Remote Access first"}
                    </span>
                  </span>
                  {runTarget === "local" ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
              </div>
            </Popover>
          </div>
        ) : null}
      </div>

      {/* Main Textarea */}
      <input type="checkbox" checked={publishPullRequest} onChange={(e) => onPublishPullRequestChange(e.target.checked)} className="sr-only" aria-label="Create pull request" tabIndex={-1} /><span className="sr-only">Create PR OpenCode {harness}</span>
      <textarea
        ref={textareaRef}
        value={task}
        onChange={(event) => onTaskChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Describe the change in this repository"
        rows={1}
        className={`w-full resize-none bg-transparent text-base lg:text-sm text-[var(--fg)] placeholder-[var(--muted-foreground-2)] focus:outline-none overflow-y-auto leading-relaxed ${
          hero ? "min-h-[96px] max-h-64" : "min-h-[72px] max-h-48"
        }`}
        aria-label="Task description"
      />

      {/* Selected skills removable chips */}
      {selectedCustomAgent ? (
        <div className="text-[10px] text-[var(--muted-foreground-2)] font-mono">
          Custom agent: {selectedCustomAgent.emoji ? `${selectedCustomAgent.emoji} ` : ""}
          {selectedCustomAgent.name}
        </div>
      ) : null}

      {selectedSkills.length > 0 || namedEnvCount > 0 ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          {selectedSkills.length > 0 ? (
            <fieldset className="flex items-center gap-1.5 flex-wrap" aria-label="Attached skills">
              {selectedSkills.map((skill) => (
                <span
                  key={skill.id}
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-[var(--radius-button)] border border-[var(--primary-soft)] bg-[var(--primary-soft)] text-[var(--primary)]"
                >
                  <Sparkles aria-hidden="true" className="size-2.5" />
                  {skill.name}
                  <button
                    type="button"
                    aria-label={`Remove skill ${skill.name}`}
                    onClick={() => onToggleSkill?.(skill.id)}
                    className="hover:text-[var(--fg)] cursor-pointer"
                  >
                    <X aria-hidden="true" className="size-2.5" />
                  </button>
                </span>
              ))}
            </fieldset>
          ) : null}
          {namedEnvCount > 0 ? (
            <button
              type="button"
              aria-label={`${namedEnvCount} ${
                namedEnvCount === 1 ? "environment variable" : "environment variables"
              } attached`}
              onClick={() => setOpen("env")}
              className="inline-flex items-center gap-1 text-[10px] font-mono font-medium px-2 py-0.5 rounded-[var(--radius-button)] border border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--secondary)] text-[var(--fg)] cursor-pointer transition-colors"
            >
              <Lock aria-hidden="true" className="size-2.5 text-[var(--icon-muted)]" />
              <span>ENV ×{namedEnvCount}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Bottom control row: + add menu, sliders thread-config, model chip, spacer, teal CTA */}
      <div className="flex items-center gap-1.5 flex-wrap pt-1">
        {/* + button (add context / tools) */}
        <div className="relative">
          <Tooltip content="Add to message: attach/repos/skills" side="top">
            <button
              type="button"
              id={idFor("menu-button")}
              aria-haspopup="menu"
              aria-expanded={open === "menu"}
              aria-label="Add to message"
              onClick={() => toggle("menu")}
              className="inline-flex items-center justify-center size-8 touch:min-h-11 touch:w-11 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] border border-[var(--border-1)] rounded-[var(--radius-button)] transition-colors cursor-pointer"
            >
              <Plus aria-hidden="true" className="size-4" />
            </button>
          </Tooltip>
          <Popover
            kind="menu"
            open={open === "menu"}
            onClose={close}
            labelledBy={idFor("menu-button")}
            className="left-0 w-64"
          >
            {menuView === "root" ? (
              <div className="py-1">
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => toggle("repo")}
                >
                  <FolderGit2 aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Repositories</span>
                  <span className="font-mono text-[10px] text-[var(--muted-foreground-2)] truncate max-w-[110px]">
                    {repoSlug || "none"}
                  </span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => setMenuView("skills")}
                >
                  <Sparkles aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Skills</span>
                  {selectedSkillIds.length > 0 ? (
                    <span className="font-mono text-[10px] text-[var(--primary)] font-semibold">
                      {selectedSkillIds.length}
                    </span>
                  ) : null}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => setOpen("env")}
                >
                  <Lock aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">Environment variables</span>
                  {namedEnvCount > 0 ? (
                    <span className="font-mono text-[10px] text-[var(--primary)] font-semibold">
                      {namedEnvCount}
                    </span>
                  ) : null}
                </button>
                <div className="my-1 border-t border-[var(--border-1)]" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className={menuRowClass}
                  onClick={() => {
                    setOpen(null);
                    onClear();
                  }}
                  disabled={clearing || busy}
                >
                  <Eraser aria-hidden="true" className={menuIconClass} />
                  <span className="flex-1">
                    {clearing ? "Clearing…" : "Clear conversation"}
                  </span>
                </button>
              </div>
            ) : (
              <div className="py-1.5">
                <button type="button" className={menuRowClass} onClick={() => setMenuView("root")}>
                  <ChevronDown
                    aria-hidden="true"
                    className="size-3.5 text-[var(--icon-muted)] rotate-90"
                  />
                  <span className="flex-1 font-medium">Skills</span>
                </button>
                <div className="my-1 border-t border-[var(--border-1)]" aria-hidden="true" />
                {skills.length === 0 ? (
                  <p className="px-3.5 py-3 text-[11px] text-[var(--muted-foreground-2)]">
                    No saved skills — add them in the Skills view.
                  </p>
                ) : (
                  skills.map((skill) => {
                    const active = selectedSkillIds.includes(skill.id);
                    return (
                      <button
                        key={skill.id}
                        type="button"
                        role="menuitemcheckbox"
                        aria-checked={active}
                        className={menuRowClass}
                        onClick={() => onToggleSkill?.(skill.id)}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-3.5 border flex items-center justify-center shrink-0 rounded-[var(--radius-inner)] ${
                            active ? "bg-[var(--primary)] border-[var(--primary)]" : "border-[var(--border-2)]"
                          }`}
                        >
                          {active ? <Check className="size-2.5 text-[var(--primary-text)]" /> : null}
                        </span>
                        <span className="flex-1 truncate">{skill.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </Popover>
          <Popover
            kind="env"
            open={open === "env"}
            onClose={close}
            labelledBy={idFor("env-popover-title")}
            className="left-0 w-80 sm:w-96"
          >
            <div className="p-3 flex flex-col gap-2.5 max-h-80 overflow-y-auto">
              <div className="flex items-center justify-between">
                <span id={idFor("env-popover-title")} className={sectionLabelClass}>
                  Environment Variables
                </span>
                <span className="text-[10px] text-[var(--muted-foreground-2)] font-mono">
                  Cloud only
                </span>
              </div>
              {envVars.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {envVars.map((row, idx) => (
                    // Positional key: a name-derived key remounts the row and drops focus on every keystroke.
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are controlled and positional
                    <div key={idx} className="flex items-center gap-1.5">
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => handleUpdateEnvVar(idx, "name", e.target.value)}
                        placeholder="NAME"
                        className={`${inputClass} font-mono w-28 sm:w-32`}
                      />
                      <input
                        type="password"
                        autoComplete="off"
                        value={row.value}
                        onChange={(e) => handleUpdateEnvVar(idx, "value", e.target.value)}
                        placeholder="value"
                        className={`${inputClass} flex-1`}
                      />
                      <button
                        type="button"
                        aria-label={`Remove ${row.name || "variable"}`}
                        onClick={() => handleRemoveEnvVar(idx)}
                        className="p-1.5 text-[var(--muted-foreground-2)] hover:text-[var(--danger,red)] hover:bg-[var(--secondary)] rounded-[var(--radius-button)] transition-colors cursor-pointer shrink-0"
                      >
                        <Trash2 aria-hidden="true" className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex items-center gap-1.5 pt-0.5">
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddEnvVar();
                    }
                  }}
                  placeholder="NAME"
                  className={`${inputClass} font-mono w-28 sm:w-32`}
                />
                <input
                  type="password"
                  autoComplete="off"
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAddEnvVar();
                    }
                  }}
                  placeholder="value"
                  className={`${inputClass} flex-1`}
                />
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="button"
                  onClick={handleAddEnvVar}
                  className="text-xs font-medium px-2.5 py-1.5 bg-[var(--primary)] text-[var(--primary-text)] rounded-[var(--radius-button)] hover:opacity-90 transition-opacity cursor-pointer"
                >
                  Add variable
                </button>
              </div>
            </div>
          </Popover>
        </div>

        {/* Sliders icon: Thread configuration (base branch, PR toggle, agent harness) */}
        <div className="relative">
          <Tooltip content="Thread configuration (branch, PR, agent)" side="top">
            <button
              type="button"
              id={idFor("config-button")}
              aria-haspopup="menu"
              aria-expanded={open === "config"}
              aria-label="Thread configuration"
              onClick={() => toggle("config")}
              className="inline-flex items-center justify-center size-8 touch:min-h-11 touch:w-11 text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] border border-[var(--border-1)] rounded-[var(--radius-button)] transition-colors cursor-pointer"
            >
              <SlidersHorizontal aria-hidden="true" className="size-4" />
            </button>
          </Tooltip>
          <Popover
            kind="config"
            open={open === "config"}
            onClose={close}
            labelledBy={idFor("config-button")}
            className="left-0 w-72"
          >
            <div className="py-2 px-3 flex flex-col gap-3">
              <span className={sectionLabelClass}>Thread Options</span>
              {/* Branch setting */}
              <div className="flex flex-col gap-1.5">
                <label htmlFor={idFor("config-branch-input")} className="text-xs text-[var(--muted-foreground-1)]">
                  Base branch
                </label>
                <div className="flex items-center gap-1.5">
                  <input
                    id={idFor("config-branch-input")}
                    type="text"
                    value={branchDraft}
                    onChange={(event) => setBranchDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        applyBranch();
                      }
                    }}
                    placeholder="main"
                    className={`${inputClass} font-mono flex-1`}
                  />
                  <button
                    type="button"
                    className="text-xs font-medium px-2 py-1.5 bg-[var(--primary)] text-[var(--primary-text)] rounded-[var(--radius-button)] hover:opacity-90 transition-opacity"
                    onClick={applyBranch}
                  >
                    Set
                  </button>
                </div>
              </div>

              {/* PR Toggle */}
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={publishPullRequest}
                className="flex items-center gap-2 text-xs text-[var(--fg)] hover:bg-[var(--secondary-hover)] p-1.5 rounded-[var(--radius-button)] transition-colors cursor-pointer text-left"
                onClick={() => onPublishPullRequestChange(!publishPullRequest)}
              >
                <GitPullRequest aria-hidden="true" className={menuIconClass} />
                <span className="flex-1">Create pull request <span className="sr-only">Create PR</span></span>
                {publishPullRequest ? (
                  <Check aria-hidden="true" className={menuCheckClass} />
                ) : null}
              </button>
              {publishPullRequest ? (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={reviewAfterPublish}
                  aria-label="Read-only review after publish"
                  className="flex items-center gap-2 text-xs text-[var(--fg)] hover:bg-[var(--secondary-hover)] p-1.5 rounded-[var(--radius-button)] transition-colors cursor-pointer text-left"
                  onClick={() => onReviewAfterPublishChange?.(!reviewAfterPublish)}
                >
                  <span className="flex-1">Read-only review after publish</span>
                  {reviewAfterPublish ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
                </button>
              ) : null}

              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={runSetup}
                aria-label="Run repo setup"
                className="flex items-center gap-2 text-xs text-[var(--fg)] hover:bg-[var(--secondary-hover)] p-1.5 rounded-[var(--radius-button)] transition-colors cursor-pointer text-left"
                onClick={() => onRunSetupChange?.(!runSetup)}
              >
                <span className="flex-1 min-w-0">
                  <span className="block">Run repo setup</span>
                  <span className="block text-[10px] text-[var(--muted-foreground-2)]">
                    Runs .shiba/setup.json initialize before the agent
                  </span>
                </span>
                {runSetup ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
              </button>

              {onCustomAgentChange && customAgents.length > 0 ? (
                <div className="border-t border-[var(--border-1)] pt-2 flex flex-col gap-1.5">
                  <span className="text-xs text-[var(--muted-foreground-1)]">Custom agent</span>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={customAgentId === ""}
                    className={`flex items-center gap-2 text-xs p-1.5 rounded-[var(--radius-button)] ${
                      customAgentId === ""
                        ? "bg-[var(--secondary-hover)] font-medium text-[var(--fg)]"
                        : "text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]"
                    }`}
                    onClick={() => onCustomAgentChange("")}
                  >
                    <span className="flex-1 truncate">Default (no profile)</span>
                    {customAgentId === "" ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
                  </button>
                  {customAgents.map((agent) => (
                    <button
                      key={agent.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={agent.id === customAgentId}
                      className={`flex items-center gap-2 text-xs p-1.5 rounded-[var(--radius-button)] ${
                        agent.id === customAgentId
                          ? "bg-[var(--secondary-hover)] font-medium text-[var(--fg)]"
                          : "text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]"
                      }`}
                      onClick={() => onCustomAgentChange(agent.id)}
                    >
                      <span className="flex-1 truncate text-left">
                        {agent.emoji ? `${agent.emoji} ` : ""}
                        {agent.name}
                        <span className="text-[10px] text-[var(--muted-foreground-2)] ml-1">{agent.slug}</span>
                      </span>
                      {agent.id === customAgentId ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="border-t border-[var(--border-1)] pt-2 flex flex-col gap-1.5">
                <span className="text-xs text-[var(--muted-foreground-1)]">Agent harness</span>
                <div className="flex flex-col gap-1">
                  {harnessOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={opt.value === harness}
                      className={`flex items-center gap-2 text-xs p-1.5 rounded-[var(--radius-button)] ${
                        opt.value === harness ? "bg-[var(--secondary-hover)] font-medium text-[var(--fg)]" : "text-[var(--muted-foreground-1)] hover:bg-[var(--secondary)]"
                      }`}
                      onClick={() => {
                        onHarnessChange(opt.value);
                      }}
                    >
                      <Bot aria-hidden="true" className="size-3.5 text-[var(--icon-muted)] shrink-0" />
                      <span className="flex-1 truncate">{opt.label}</span>
                      {opt.value === harness ? <Check aria-hidden="true" className={menuCheckClass} /> : null}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </Popover>
        </div>

        {/* Model Chip (Provider icon + Model name + Chevron) */}
        <div className="relative">
          <Tooltip
            content={
              routing.codingModel
                ? `Model: ${routing.codingModel}${currentConnection ? ` via ${currentConnection.label}` : ""}`
                : "Coding model — deployment default"
            }
            side="top"
          >
            <button
              type="button"
              id={idFor("model-button")}
              aria-haspopup="menu"
              aria-expanded={open === "model"}
              aria-label={`Model: ${routing.codingModel || "Claude Opus 5.5"}`}
              onClick={() => toggle("model")}
              className={`${pillClass} border border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--secondary)] text-[var(--fg)]`}
            >
              {routing.codingModel.toLowerCase().includes("claude") ||
              routing.codingModel.toLowerCase().includes("anthropic") ||
              routing.codingModel === "" ? (
                <AnthropicIcon className="size-3.5 text-[#cc785c] shrink-0" />
              ) : (
                <Cpu aria-hidden="true" className="size-3.5 text-[var(--icon-muted)] shrink-0" />
              )}
              <span className={`${pillLabelClass} font-mono`}>
                {routing.codingModel ? modelTail(routing.codingModel) : "Claude Opus 5.5"}
              </span>
              {chevron}
            </button>
          </Tooltip>
          <Popover
            kind="model"
            open={open === "model"}
            onClose={close}
            labelledBy={idFor("model-button")}
            className="left-0 w-72"
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-1)]">
              <Search aria-hidden="true" className="size-3.5 text-[var(--icon-muted)]" />
              <input
                type="text"
                value={modelFilter}
                onChange={(event) => setModelFilter(event.target.value)}
                placeholder="Search models…"
                aria-label="Search models"
                className="flex-1 bg-transparent text-xs text-[var(--fg)] placeholder-[var(--muted-foreground-3)] focus:outline-none"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              <button
                type="button"
                role="menuitemradio"
                aria-checked={routing.codingModel === ""}
                className={menuRowClass}
                onClick={() => {
                  routing.onCodingModelChange("");
                  setOpen(null);
                }}
              >
                <Cpu aria-hidden="true" className={menuIconClass} />
                <span className="flex-1 font-medium">Auto — deployment default</span>
                {routing.codingModel === "" ? (
                  <Check aria-hidden="true" className={menuCheckClass} />
                ) : null}
              </button>
              {filteredModels.length > 0 ? (
                <>
                  <div className="mx-3 my-1 border-t border-[var(--border-1)]" aria-hidden="true" />
                  {filteredModels.map((model) => (
                    <button
                      key={model}
                      type="button"
                      role="menuitemradio"
                      aria-checked={model === routing.codingModel}
                      className={`${menuRowClass} font-mono`}
                      onClick={() => {
                        routing.onCodingModelChange(model);
                        setOpen(null);
                      }}
                    >
                      <span className="flex-1 truncate text-left">{model}</span>
                      {model === routing.codingModel ? (
                        <Check aria-hidden="true" className={menuCheckClass} />
                      ) : null}
                    </button>
                  ))}
                </>
              ) : null}
              {connections.length > 0 ? (
                <>
                  <div className="mx-3 my-1 border-t border-[var(--border-1)]" aria-hidden="true" />
                  <p className={`px-3 pt-1.5 pb-0.5 ${sectionLabelClass}`}>Route via</p>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={routing.connectionId === ""}
                    className={menuRowClass}
                    onClick={() => routing.onConnectionChange("")}
                  >
                    <span className="flex-1">Auto route</span>
                    {routing.connectionId === "" ? (
                      <Check aria-hidden="true" className={menuCheckClass} />
                    ) : null}
                  </button>
                  {connections.map((connection) => (
                    <button
                      key={connection.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={connection.id === routing.connectionId}
                      className={menuRowClass}
                      onClick={() => routing.onConnectionChange(connection.id)}
                    >
                      <span className="flex-1 truncate">{connection.label}</span>
                      {connection.id === routing.connectionId ? (
                        <Check aria-hidden="true" className={menuCheckClass} />
                      ) : null}
                    </button>
                  ))}
                </>
              ) : null}
            </div>
            <div className="border-t border-[var(--border-1)] px-3 py-2.5 flex flex-col gap-2">
              <label htmlFor={idFor("model-input")} className={sectionLabelClass}>
                Custom model
              </label>
              <div className="flex items-center gap-1.5">
                <input
                  id={idFor("model-input")}
                  type="text"
                  value={modelDraft}
                  onChange={(event) => setModelDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && modelDraft.trim()) {
                      event.preventDefault();
                      applyCustomModel();
                    }
                  }}
                  placeholder="provider/model"
                  className={`${inputClass} flex-1 font-mono`}
                />
                <button
                  type="button"
                  disabled={!modelDraft.trim()}
                  onClick={applyCustomModel}
                  className="text-xs font-medium px-2 py-1.5 border border-[var(--border-1)] text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] rounded-[var(--radius-button)] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Use
                </button>
              </div>
              {!modelKnown ? (
                <p className="text-[10px] text-[var(--muted-foreground-2)]">
                  Current: <span className="font-mono">{routing.codingModel}</span> (custom)
                </p>
              ) : null}
            </div>
          </Popover>
        </div>

        {/* Effort Chip (Gauge icon + Effort label + Chevron) */}
        {supportedEfforts && supportedEfforts.length > 0 ? (
          <div className="relative">
            <Tooltip
              content={
                selectedEffort
                  ? `Reasoning effort: ${formatEffort(selectedEffort)}`
                  : "Reasoning effort — default"
              }
              side="top"
            >
              <button
                type="button"
                id={idFor("effort-button")}
                aria-haspopup="menu"
                aria-expanded={open === "effort"}
                aria-label={`Reasoning effort: ${selectedEffort || "default"}`}
                onClick={() => toggle("effort")}
                className={`${pillClass} border border-[var(--border-1)] bg-[var(--card)] hover:bg-[var(--secondary)] text-[var(--fg)]`}
              >
                <Gauge aria-hidden="true" className="size-3.5 text-[var(--icon-muted)] shrink-0" />
                <span className={pillLabelClass}>
                  {selectedEffort ? formatEffort(selectedEffort) : "Effort"}
                </span>
                {chevron}
              </button>
            </Tooltip>
            <Popover
              kind="effort"
              open={open === "effort"}
              onClose={close}
              labelledBy={idFor("effort-button")}
              className="left-0 w-44"
            >
              <div className="py-1">
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selectedEffort === ""}
                  className={menuRowClass}
                  onClick={() => {
                    routing.onReasoningEffortChange("");
                    setOpen(null);
                  }}
                >
                  <span className="flex-1 truncate text-left">Default</span>
                  {selectedEffort === "" ? (
                    <Check aria-hidden="true" className={menuCheckClass} />
                  ) : null}
                </button>
                {supportedEfforts.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="menuitemradio"
                    aria-checked={level === selectedEffort}
                    className={menuRowClass}
                    onClick={() => {
                      routing.onReasoningEffortChange(level);
                      setOpen(null);
                    }}
                  >
                    <span className="flex-1 truncate text-left">{formatEffort(level)}</span>
                    {level === selectedEffort ? (
                      <Check aria-hidden="true" className={menuCheckClass} />
                    ) : null}
                  </button>
                ))}
              </div>
            </Popover>
          </div>
        ) : null}

        <div className="flex-1 min-w-0 flex flex-col items-end justify-center gap-0.5">
          {isSubmitting ? (
            <span className="text-[10px] text-[var(--primary)] font-medium" data-testid="composer-status">
              Sending task…
            </span>
          ) : busy && !sendDisabled ? (
            <span className="text-[10px] text-[var(--muted-foreground-2)]" data-testid="composer-status">
              Planner responding — wait to send again
            </span>
          ) : null}
        </div>

        {/* Voice dictation */}
        {getSpeechRecognitionClass() ? (
          <Tooltip content="Dictate — uses your browser's speech recognition" side="top">
            <button
              type="button"
              onClick={toggleListening}
              aria-label={listening ? "Stop voice input" : "Voice input"}
              aria-pressed={listening}
              className={`inline-flex items-center justify-center size-8 touch:min-h-11 touch:w-11 rounded-[var(--radius-button)] border transition-colors cursor-pointer ${
                listening
                  ? "bg-[var(--primary)] text-[var(--primary-text)] border-[var(--primary)]"
                  : "text-[var(--muted-foreground-1)] hover:text-[var(--fg)] hover:bg-[var(--secondary)] border-[var(--border-1)]"
              }`}
            >
              <Mic aria-hidden="true" className="size-4" />
            </button>
          </Tooltip>
        ) : null}

        {/* Send */}
        <Tooltip content="Submit task to coding agent" shortcut="⌘↵" side="top">
          <button
            type="submit"
            disabled={sendDisabled || isSubmitting}
            aria-label={isSubmitting ? "Sending…" : "Send task"}
            className="inline-flex items-center justify-center size-8 touch:min-h-11 touch:w-11 bg-[var(--primary)] hover:opacity-90 text-[var(--primary-text)] rounded-[var(--radius-button)] transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-[var(--sh-plate)] active:scale-95"
          >
            <ArrowUp aria-hidden="true" className="size-4" strokeWidth={2.5} />
          </button>
        </Tooltip>
      </div>
    </form>
  );

  if (!hero) return form;

  return (
    <div className="flex-1 min-h-0 w-full overflow-y-auto flex flex-col items-center justify-center px-4 py-8 relative">
      <div className="absolute inset-0 dot-grid pointer-events-none" aria-hidden="true" />
      <div className="w-full max-w-[640px] flex flex-col items-center gap-5 z-10">
        <div className="text-center px-2">
          <h2 className="text-[24px] leading-[1.05] text-[var(--fg)]">What should Shiba change?</h2>
          <p className="mt-2 text-[11px] font-mono uppercase tracking-[0.14em] text-[var(--muted-foreground-2)]">
            Pick a repo, describe the task, then send. The sandbox starts only after you approve.
          </p>
        </div>
        {form}
      </div>
    </div>
  );
}
