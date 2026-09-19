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
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { isToolUIPart, type UIMessage } from "ai";
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

interface ApprovalCardProps {
  approval: PendingApproval;
  decided: boolean;
  onDecideApproval: (approvalId: string, approved: boolean) => void;
}

function ApprovalCard({ approval, decided, onDecideApproval }: ApprovalCardProps) {
  return (
    <div className="border border-[#c9a227]/60 bg-[#0a0c10] rounded-xl p-4 shadow-lg shadow-[#c9a227]/5 flex flex-col gap-3 w-full">
      <div className="flex items-center justify-between gap-3">
        <div className="font-mono font-bold text-sm text-[#e6edf3] flex items-center gap-2">
          <img
            src="/assets/mascot/pet-logo.png"
            alt=""
            className="w-5 h-5 rounded-full bg-white object-contain border border-amber-500/50"
          />
          {approval.tool}
        </div>
        <span className="text-[10px] uppercase tracking-wider font-bold bg-[#c9a227]/15 border border-[#c9a227]/30 text-[#c9a227] px-2 py-0.5 rounded-full">
          Action Required
        </span>
      </div>

      <pre className="whitespace-pre-wrap font-mono text-xs text-[#8b98a9] bg-black p-3 rounded-lg border border-[#1e2530] max-h-56 overflow-auto">
        {typeof approval.input === "string"
          ? approval.input
          : JSON.stringify(approval.input, null, 2)}
      </pre>

      <p className="text-xs text-[#8b98a9] leading-relaxed">
        Approving starts an isolated sandbox run. Rejecting stops the tool call.
      </p>

      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          className="bg-[#4cc38a] hover:bg-[#3ba875] text-[#06121f] font-semibold py-2 px-5 rounded-lg transition-colors disabled:opacity-50 text-sm shadow-sm flex items-center gap-1.5"
          disabled={decided}
          onClick={() => onDecideApproval(approval.approvalId, true)}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
          </svg>
          <span>Approve</span>
        </button>
        <button
          type="button"
          className="bg-transparent border border-[#f06666] text-[#f06666] hover:bg-[#f06666]/10 font-semibold py-2 px-5 rounded-lg transition-colors disabled:opacity-50 text-sm flex items-center gap-1.5"
          disabled={decided}
          onClick={() => onDecideApproval(approval.approvalId, false)}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span>Reject</span>
        </button>
      </div>
    </div>
  );
}

function statusChipClass(rejected: boolean, waiting: boolean): string {
  if (rejected) return "text-[#f06666] border-[#f06666]/30 bg-[#f06666]/10";
  if (waiting) return "text-[#c9a227] border-[#c9a227]/30 bg-[#c9a227]/10 animate-pulse";
  return "text-[#8b98a9] border-[#1e2530] bg-[#0a0c10]";
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
      <div className="flex flex-col items-center justify-center py-16 border border-dashed border-[#1e2530] rounded-xl bg-[#0a0c10]/40 px-6 text-center">
        <img
          src="/assets/mascot/shiba-sticker-hero.webp"
          alt="Shiba illustration mascot"
          className="w-56 h-auto max-h-40 rounded-xl shadow-lg border border-[#0B9F95]/30 mb-3 object-cover"
        />
        <p className="text-[#8b98a9] text-sm mb-2 font-medium">
          No messages yet. Submit a task to start.
        </p>
        {starters && starters.length > 0 ? (
          <div className="flex flex-wrap items-center justify-center gap-2 mt-3 max-w-md">
            {starters.map((starter) => (
              <button
                key={starter.label}
                type="button"
                onClick={() => onStarter?.(starter.task)}
                className="inline-flex items-center gap-1.5 text-xs text-[#e6edf3] bg-[#11141b] hover:bg-[#1e2530] border border-[#1e2530] rounded-full px-3 py-1.5 transition-colors"
              >
                <span aria-hidden="true">{starter.icon}</span>
                {starter.label}
              </button>
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
              <div className="flex items-center gap-1.5 text-xs font-semibold text-[#8b98a9] uppercase tracking-wider mb-1 px-1">
                <span>You</span>
                <span className="w-1.5 h-1.5 rounded-full bg-[#4f9cf0]" />
              </div>
              <div className="flex flex-col gap-2 max-w-[92%] md:max-w-[85%] bg-[#4f9cf0] text-[#06121f] rounded-2xl rounded-tr-sm p-4 font-medium shadow-sm">
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
            <div className="relative pl-9 flex flex-col gap-3 w-full before:content-[''] before:absolute before:left-[11px] before:top-2 before:bottom-2 before:w-px before:bg-[#1e2530]">
              {message.parts.map((part, index) => {
                const text = partText(part);
                if (text !== null) {
                  return (
                    <div key={index} className="relative">
                      <span className="absolute -left-9 top-0.5 w-6 h-6 rounded-full bg-[#0a0c10] border border-[#1e2530] flex items-center justify-center text-[#8b98a9]">
                        <RailIcon kind="text" />
                      </span>
                      <div className="bg-[#0a0c10] border border-[#1e2530] text-[#e6edf3] rounded-2xl rounded-tl-sm p-4 shadow-sm max-w-[92%] md:max-w-[85%]">
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
                  const pendingApproval = waiting
                    ? pendingApprovals.find(
                        (a) =>
                          a.messageId === message.id && a.toolCallId === callId,
                      )
                    : undefined;

                  return (
                    <div key={index} className="relative flex flex-col gap-3">
                      <span
                        className={`absolute -left-9 top-0.5 w-6 h-6 rounded-full bg-[#0a0c10] border flex items-center justify-center ${
                          waiting
                            ? "border-[#c9a227]/60 text-[#c9a227]"
                            : "border-[#1e2530] text-[#8b98a9]"
                        }`}
                      >
                        <RailIcon kind={waiting ? "approval" : "tool"} />
                      </span>
                      <div className="flex flex-wrap items-center gap-2 bg-[#0a0c10]/70 p-2.5 rounded-lg border border-[#1e2530]/60 font-mono text-xs w-fit max-w-full">
                        <span className="text-[#2dd4bf] font-semibold bg-[#11141b] px-2 py-0.5 rounded">
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
                          <summary className="cursor-pointer text-[11px] font-mono text-[#8b98a9] hover:text-[#e6edf3] transition-colors select-none">
                            Output
                          </summary>
                          <pre className="mt-1 whitespace-pre-wrap font-mono text-xs text-[#8b98a9] bg-black p-3 rounded-lg border border-[#1e2530] max-h-56 overflow-auto">
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
            <span className="absolute left-0 top-0.5 w-6 h-6 rounded-full bg-[#0a0c10] border border-[#0B9F95]/40 flex items-center justify-center">
              <img
                src="/assets/mascot/pet-logo.png"
                alt=""
                className="w-4 h-4 rounded-full bg-white object-contain animate-bounce"
              />
            </span>
            <div className="bg-[#0a0c10] border border-[#1e2530] rounded-2xl rounded-tl-sm p-4 text-xs text-[#8b98a9] flex items-center gap-2 w-fit">
              <span className="animate-spin inline-block w-3.5 h-3.5 border-2 border-[#2dd4bf] border-t-transparent rounded-full" />
              <span className="text-[#2dd4bf] font-semibold">Shiba is reasoning…</span>
            </div>
          </div>
        </li>
      ) : null}
    </ol>
  );
}
