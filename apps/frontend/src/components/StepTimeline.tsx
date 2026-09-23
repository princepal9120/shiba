/**
 * StepTimeline — Devin-style conversation feed.
 * User messages render as right-aligned blue bubbles; assistant/tool parts
 * render as steps on a left icon rail with a vertical connecting line.
 * waiting-approval tool parts also render the inline approval card —
 * the approval gate is sacred: never auto-approve, never hide.
 */
import {
  getToolApproval,
  getToolCallId,
  getToolInput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";
import { ApprovalCard } from "./ApprovalCard";
import { Tooltip } from "./Tooltip";
import {
  toolDisplayName,
  type PendingApproval,
  type ToolPart,
} from "../ui-helpers";

export interface StepTimelineProps {
  messages: UIMessage[];
  isStreaming: boolean;
  pendingApprovals: PendingApproval[];
  decisions: Record<string, boolean>;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
  renderToolOutput?: (part: ToolPart) => string | null; // optional, has default
  starters?: { icon: string; label: string; task: string }[];
  onStarter?: (task: string) => void;
}

function partText(part: ToolPart): string | null {
  if (typeof part !== "object" || part === null) return null;
  const typed = part as { type?: unknown; text?: unknown };
  if (typed.type === "text" && typeof typed.text === "string") {
    return typed.text;
  }
  return null;
}

function defaultRenderToolOutput(part: ToolPart): string | null {
  if (typeof part !== "object" || part === null) return null;
  const typed = part as Record<string, unknown>;
  const output = typed.output ?? typed.result;
  if (output === undefined || output === null) return null;
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function WrenchIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
      />
    </svg>
  );
}

function RailIcon({ kind }: { kind: "tool" | "text" | "approval" }) {
  if (kind === "text") {
    return (
      <img
        src="/assets/mascot/pet-logo.png"
        alt=""
        className="w-4 h-4 rounded-full bg-white object-contain"
      />
    );
  }
  if (kind === "approval") {
    return <ShieldIcon />;
  }
  return <WrenchIcon />;
}

function statusChipClass(rejected: boolean, waiting: boolean): string {
  if (rejected) return "text-[#fb2c36] border-[#fb2c36]/30 bg-[#fb2c36]/10";
  if (waiting) return "text-[#b45309] border-[#b45309]/30 bg-[#b45309]/10 animate-pulse";
  return "text-slate-500 border-slate-200 bg-white";
}

export function StepTimeline({
  messages,
  isStreaming,
  pendingApprovals,
  decisions,
  onDecideApproval,
  renderToolOutput = defaultRenderToolOutput,
  starters,
  onStarter,
}: StepTimelineProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 border border-dashed border-slate-200 rounded-xl bg-white/40 px-6 text-center">
        <img
          src="/assets/mascot/shiba-sticker-hero.webp"
          alt="Shiba illustration mascot"
          className="w-56 h-auto max-h-40 rounded-xl shadow-lg border border-[#0000a8]/30 mb-3 object-cover"
        />
        <h2 className="font-display text-3xl text-slate-900 mb-1">
          Delegate the next task.
        </h2>
        <p className="text-slate-500 text-sm mb-2 font-medium">
          No messages yet. Submit a task to start.
        </p>
        {starters && starters.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-2 mt-3 max-w-md">
            {starters.map((starter) => (
              <Tooltip key={starter.label} content={starter.task} side="bottom" delayMs={200}>
                <button
                  type="button"
                  onClick={() => onStarter?.(starter.task)}
                  className="inline-flex items-center gap-1.5 text-xs text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-full px-3 py-1.5 transition-colors active:scale-95"
                >
                  <span aria-hidden="true">{starter.icon}</span>
                  {starter.label}
                </button>
              </Tooltip>
            ))}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <ol className="flex flex-col gap-5">
      {messages.map((message) => {
        if (message.role === "user") {
          return (
            <li key={message.id} className="flex flex-col items-end">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1 px-1">
                <span>You</span>
                <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
              </div>
              <div className="flex flex-col gap-2 max-w-[92%] md:max-w-[85%] bg-blue-600 text-white rounded-2xl rounded-tr-sm p-4 font-medium shadow-sm">
                {message.parts.map((part, index) => {
                  const text = partText(part);
                  if (text === null) return null;
                  return (
                    <pre
                      key={index}
                      className="whitespace-pre-wrap font-sans text-sm break-words leading-relaxed"
                    >
                      {text}
                    </pre>
                  );
                })}
              </div>
            </li>
          );
        }

        // Assistant / tool steps on the left icon rail.
        return (
          <li key={message.id} className="flex flex-col items-start">
            <div className="relative pl-9 flex flex-col gap-3 w-full before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-[var(--line)]">
              {message.parts.map((part, index) => {
                const text = partText(part);
                if (text !== null) {
                  return (
                    <div key={message.id + ":text:" + index} className="relative">
                      <span className="absolute -left-9 top-0.5 w-6 h-6 rounded-full bg-white border border-slate-200 flex items-center justify-center text-slate-500">
                        <RailIcon kind="text" />
                      </span>
                      <div className="bg-white border border-slate-200 text-slate-900 rounded-2xl rounded-tl-sm p-4 shadow-sm max-w-[92%] md:max-w-[85%]">
                        <pre className="whitespace-pre-wrap font-sans text-sm break-words leading-relaxed">
                          {text}
                        </pre>
                      </div>
                    </div>
                  );
                }

                if (isToolUIPart(part)) {
                  const state = getToolPartState(part);
                  const approval = getToolApproval(part);
                  const rejected = approval?.approved === false;
                  const waiting = state === "waiting-approval";
                  const output = renderToolOutput(part);
                  const callId = getToolCallId(part);
                  // Build the gate card from the tool part itself; the
                  // pendingApprovals join is only a decided-state lookup.
                  const approvalId = approval?.id;
                  const pendingApproval: PendingApproval | undefined =
                    waiting && approvalId
                      ? pendingApprovals.find((a) => a.approvalId === approvalId) ?? {
                          messageId: message.id,
                          toolCallId: callId,
                          approvalId,
                          tool: toolDisplayName(part),
                          input: getToolInput(part),
                        }
                      : undefined;

                  return (
                    <div key={callId ?? (message.id + ":tool:" + index)} className="relative flex flex-col gap-3">
                      <span
                        className={`absolute -left-9 top-0.5 w-6 h-6 rounded-full bg-white border flex items-center justify-center ${
                          waiting
                            ? "border-[#b45309]/60 text-[#b45309]"
                            : "border-slate-200 text-slate-500"
                        }`}
                      >
                        <RailIcon kind={waiting ? "approval" : "tool"} />
                      </span>
                      <div className="flex flex-wrap items-center gap-2 bg-white/70 p-2.5 rounded-lg border border-slate-200/60 font-mono text-xs w-fit max-w-full">
                        <span className="text-blue-600 font-semibold bg-white px-2 py-0.5 rounded">
                          Ran {toolDisplayName(part)}
                        </span>
                        <span
                          className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${statusChipClass(
                            rejected,
                            waiting,
                          )}`}
                        >
                          {rejected ? "Rejected" : state}
                        </span>
                      </div>
                      {output !== null && output !== "" ? (
                        <details className="max-w-[92%] md:max-w-[85%] group">
                          <summary className="cursor-pointer text-[11px] font-mono text-slate-500 hover:text-slate-900 transition-colors select-none">
                            Output
                          </summary>
                          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-slate-500 bg-white p-3 rounded-lg border border-slate-200 max-h-56 overflow-auto">
                            {output}
                          </pre>
                        </details>
                      ) : null}
                      {waiting && pendingApproval ? (
                        <ApprovalCard
                          approval={pendingApproval}
                          decided={decisions[pendingApproval.approvalId] !== undefined}
                          onDecideApproval={onDecideApproval}
                        />
                      ) : null}
                    </div>
                  );
                }

                return null;
              })}
            </div>
          </li>
        );
      })}

      {isStreaming ? (
        <li className="flex flex-col items-start">
          <div className="relative pl-9">
            <span className="absolute left-0 top-0.5 w-6 h-6 rounded-full bg-white border border-[#0000a8]/40 flex items-center justify-center">
              <img
                src="/assets/mascot/pet-logo.png"
                alt=""
                className="w-4 h-4 rounded-full bg-white object-contain animate-bounce"
              />
            </span>
            <div className="bg-white border border-slate-200 rounded-2xl rounded-tl-sm p-4 text-xs text-slate-500 flex items-center gap-2 w-fit">
              <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-[#1c1cc8] border-t-transparent rounded-full" />
              <span className="text-blue-600 font-semibold">Shiba is reasoning…</span>
            </div>
          </div>
        </li>
      ) : null}
    </ol>
  );
}
