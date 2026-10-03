/**
 * FirstRunWizard — the post-signup onboarding flow. Three steps:
 *   1. Channels  — pick the surfaces you want tasks & approvals on
 *      (Slack/Telegram/Discord/Email/GitHub; status is live, setup itself is
 *      deployment-provisioned and the row says where).
 *   2. Your agent — connect one AI provider via the shared
 *      SubscriptionConnect control.
 *   3. Model routing — the deployment's role→harness map, read-only, with a
 *      link into Settings → Models.
 * Opens automatically on the first authenticated session
 * (`shiba-onboarding-v1` in localStorage) and can be reopened from Setup
 * Guide. Steps never block: "Skip" always works, "Finish" marks it done.
 */
import { useMemo, useState, type JSX } from "react";
import type { AppNavView } from "./AppNavRail";
import { ToneChip } from "./ToneChip";
import {
  SUBSCRIPTION_AUTH,
  SubscriptionConnect,
  subscriptionChip,
  type SubscriptionId,
  type SubscriptionStatus,
} from "./SubscriptionConnect";
import {
  useAgentsDirectory,
  useMailboxes,
  useSetupStatus,
} from "../live-status";

export const ONBOARDING_STORAGE_KEY = "shiba-onboarding-v1";

const STEPS = [
  { id: "channels", title: "Your channels", blurb: "Where tasks and approvals reach you" },
  { id: "agent", title: "Your agent", blurb: "The AI provider that does the work" },
  { id: "models", title: "Model routing", blurb: "Which agent handles each kind of task" },
] as const;

function WizardShell({
  step,
  onClose,
  children,
}: {
  step: number;
  onClose: () => void;
  children: React.ReactNode;
}): JSX.Element {
  const current = STEPS[step] ?? STEPS[0];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Welcome setup"
        className="w-full max-w-lg rounded-none border border-[#e0ded5] bg-[#fffef8] shadow-[4px_4px_0_var(--paper-shadow)]"
      >
        <div className="border-b border-[#e0ded5] px-5 py-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] text-[#1c1cc8]">
                Welcome — {step + 1} of {STEPS.length}
              </div>
              <h2 className="mt-0.5 text-base font-semibold text-[#222320]">
                {current.title}
              </h2>
              <p className="mt-0.5 text-xs text-[#6a6f63]">{current.blurb}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close setup"
              className="size-8 shrink-0 rounded-none text-[#6a6f63] hover:bg-[#e0ded5] hover:text-[#222320]"
            >
              ✕
            </button>
          </div>
          <div className="mt-3 flex gap-1.5">
            {STEPS.map((s, i) => (
              <span
                key={s.id}
                className={`h-1 flex-1 rounded-none ${i <= step ? "bg-[#0000a8]" : "bg-[#e0ded5]"}`}
              />
            ))}
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function Footer({
  step,
  setStep,
  onFinish,
}: {
  step: number;
  setStep: (n: number) => void;
  onFinish: () => void;
}): JSX.Element {
  const last = step === STEPS.length - 1;
  return (
    <div className="flex items-center justify-between gap-3 pt-4">
      <button
        type="button"
        onClick={onFinish}
        className="font-mono text-[11px] text-[#6a6f63] hover:text-[#222320]"
      >
        Skip setup
      </button>
      <div className="flex items-center gap-2">
        {step > 0 ? (
          <button
            type="button"
            onClick={() => setStep(step - 1)}
            className="rounded-none border border-[#e0ded5] bg-[#fffef8] px-3 py-1.5 font-mono text-[11px] font-medium text-[#6a6f63] hover:border-[#d3d2c8] hover:text-[#222320]"
          >
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={() => (last ? onFinish() : setStep(step + 1))}
          className="rounded-none bg-[#0000a8] px-4 py-1.5 font-mono text-[11px] font-semibold text-white shadow-[2px_2px_0_var(--paper-shadow)] transition-colors hover:bg-[#1c1cc8] active:translate-y-px"
        >
          {last ? "Finish" : "Next"}
        </button>
      </div>
    </div>
  );
}

function ChannelRow({
  name,
  status,
  children,
}: {
  name: string;
  status: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-[#e0ded5]/60 py-2.5 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-[#222320]">{name}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-[#6a6f63]">{children}</div>
      </div>
      <div className="shrink-0 pt-0.5">{status}</div>
    </div>
  );
}

function AgentRow({ id, agentCredential }: { id: SubscriptionId; agentCredential?: { kind: string; label: string; configured: boolean | null; setupHint: string | null } }): JSX.Element {
  const spec = SUBSCRIPTION_AUTH[id];
  const credential = (agentCredential as never) ?? spec.credential;
  const [status, setStatus] = useState<SubscriptionStatus>({ kind: "loading" });
  return (
    <div className="border-b border-[#e0ded5]/60 py-3 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-[#222320]">{spec.label}</div>
          <div className="mt-0.5 text-[11px] text-[#6a6f63]">{spec.blurb}</div>
        </div>
        <div className="shrink-0">{subscriptionChip(status)}</div>
      </div>
      <SubscriptionConnect spec={spec} credential={credential} onStatus={setStatus} />
    </div>
  );
}

export function FirstRunWizard({
  open,
  onClose,
  onNavigate,
  onOpenChecklist,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate?: (view: AppNavView) => void;
  onOpenChecklist?: () => void;
}): JSX.Element | null {
  const [step, setStep] = useState(0);
  const directory = useAgentsDirectory();
  const setup = useSetupStatus();
  const mailboxes = useMailboxes();

  const agents = directory.state.kind === "data" ? directory.state.data.agents : [];
  const status = setup.state.kind === "data" ? setup.state.data : undefined;
  const mailboxList = mailboxes.state.kind === "data" ? mailboxes.state.data.mailboxes : undefined;
  const subscriptionIds = useMemo(() => Object.keys(SUBSCRIPTION_AUTH) as SubscriptionId[], []);

  if (!open) return null;

  const finish = () => {
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "done");
    } catch {
      // private mode — just close
    }
    onClose();
  };

  return (
    <WizardShell step={step} onClose={finish}>
      {step === 0 ? (
        <div>
          <ChannelRow
            name="GitHub"
            status={
              status === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : status.github.token ? (
                <ToneChip tone="ok" label="Connected" />
              ) : (
                <ToneChip tone="neutral" label="Not set up" />
              )
            }
          >
            Pull requests and repo events.
          </ChannelRow>
          <ChannelRow
            name="Slack"
            status={
              status === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : status.slack.signingSecret && status.slack.botToken ? (
                <ToneChip tone="ok" label="Connected" />
              ) : (
                <ToneChip tone="neutral" label="Not set up" />
              )
            }
          >
            Approve runs in chat.
          </ChannelRow>
          <ChannelRow name="Telegram" status={<ToneChip tone="neutral" label="Optional" />}>
            Task intake through a bot.
          </ChannelRow>
          <ChannelRow name="Discord" status={<ToneChip tone="neutral" label="Optional" />}>
            Commands and progress posts.
          </ChannelRow>
          <ChannelRow
            name="Email"
            status={
              mailboxList === undefined ? (
                <ToneChip tone="neutral" label="Checking…" />
              ) : mailboxList.length > 0 ? (
                <ToneChip tone="ok" label="Connected" />
              ) : (
                <ToneChip tone="neutral" label="Not set up" />
              )
            }
          >
            Inbound triage and approved sends.
          </ChannelRow>
          <p className="mt-3 text-[11px] leading-relaxed text-[#6a6f63]">
            Channel setup is done in your deployment settings. Anything not set up can be added
            later from the Integrations page.
          </p>
          {onNavigate ? (
            <button
              type="button"
              onClick={() => {
                finish();
                onNavigate("integrations");
              }}
              className="mt-2 font-mono text-[11px] font-medium text-[#1c1cc8] hover:text-[#0000a8]"
            >
              Open Integrations →
            </button>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div>
          {subscriptionIds.map((id) => (
            <AgentRow
              key={id}
              id={id}
              agentCredential={agents.find((a) => a.id === id)?.credential}
            />
          ))}
          <p className="mt-3 text-[11px] leading-relaxed text-[#6a6f63]">
            Connect at least one agent to run tasks. You can add or switch providers later in
            Settings → Providers.
          </p>
        </div>
      ) : null}

      {step === 2 ? (
        <div>
          {agents.length === 0 ? (
            <p className="text-[11px] text-[#6a6f63]">
              No agent catalog reported yet — routing falls back to the deployment default.
            </p>
          ) : (
            <div className="space-y-1.5">
              {agents.slice(0, 6).map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center justify-between gap-3 border-b border-[#e0ded5]/60 py-2 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-[#222320]">{agent.label}</div>
                    <div className="font-mono text-[10px] text-[#6a6f63]">
                      default model: {agent.defaultModel}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-[#6a6f63]">
            Routing decides which agent handles each task role. Tune it any time in
            Settings → Models.
          </p>
          {onNavigate ? (
            <button
              type="button"
              onClick={() => {
                finish();
                onNavigate("settings");
              }}
              className="mt-2 font-mono text-[11px] font-medium text-[#1c1cc8] hover:text-[#0000a8]"
            >
              Open Settings →
            </button>
          ) : null}
        </div>
      ) : null}

      <Footer step={step} setStep={setStep} onFinish={finish} />

      {onOpenChecklist ? (
        <p className="mt-3 border-t border-[#e0ded5]/60 pt-3">
          <button
            type="button"
            onClick={() => {
              onClose();
              onOpenChecklist();
            }}
            className="font-mono text-[10px] text-[#6a6f63] hover:text-[#222320]"
          >
            Operator? Open the deployment checklist →
          </button>
        </p>
      ) : null}
    </WizardShell>
  );
}
