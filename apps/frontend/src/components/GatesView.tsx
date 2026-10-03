import { useState, type JSX } from "react";
import type { AppNavView } from "./AppNavRail";

interface GateDef {
  id: string;
  name: string;
  description: string;
  /** Button verb — the card's primary action reads as its own intent. */
  actionLabel: string;
  /** Builds the run task. `extra` is the gate-specific input (e.g. PR number). */
  task: (repoUrl: string, extra: string) => string;
  extraLabel?: string;
  extraPlaceholder?: string;
}

const GATES: GateDef[] = [
  {
    id: "review",
    name: "Code Review",
    description: "Exhaustive review of a pull request or the latest changes — correctness, regressions, test gaps — with fixes applied in a PR.",
    actionLabel: "Queue review",
    extraLabel: "PR number or branch",
    extraPlaceholder: "42",
    task: (repo, extra) =>
      extra.trim()
        ? `Review pull request/branch "${extra.trim()}" in ${repo}: correctness bugs, missing tests, security issues, and regressions. Apply blocking fixes and open a PR.`
        : `Review the most recent changes on the default branch of ${repo}: correctness bugs, missing tests, security issues, and regressions. Apply blocking fixes and open a PR.`,
  },
  {
    id: "qa",
    name: "QA — Test Generation",
    description: "Generate missing unit and integration tests for recently changed code, run the suite, and ship the additions as a PR.",
    actionLabel: "Generate tests",
    task: (repo) =>
      `Generate missing tests in ${repo}: find recently changed code paths without coverage, write unit/integration tests matching the repo's existing test style, run the suite, then run \`procoder check\` on the changed files and fix its findings, and open a PR with the additions.`,
  },
  {
    id: "security",
    name: "Security Review",
    description: "STRIDE + OWASP audit of the repository: injection paths, authz gaps, secret leakage, unsafe dependencies — fixed and shipped as a PR.",
    actionLabel: "Run security audit",
    task: (repo) =>
      `Security-audit ${repo} against STRIDE and the OWASP Top 10: trace untrusted input to sinks, check authz boundaries, scan for committed secrets and vulnerable dependencies. Fix confirmed findings, run \`procoder check\` on the changed files, and open a PR.`,
  },
];

interface GateNotice {
  kind: "error" | "ok";
  text: string;
  approvalId?: string;
}

const REPO_RE = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/;

const inputClass =
  "w-full bg-[#fffef8] text-xs font-mono text-[#222320] border border-[#e0ded5] rounded-none px-3 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-[#6a6f63]/50";
const labelClass = "text-[11px] font-semibold text-[#222320]";

/**
 * Quality Gates — dedicated entry points for review, QA, and security runs.
 * Every gate queues a normal approval-gated run; nothing bypasses review.
 */
export function GatesView({ onNavigate }: { onNavigate?: (view: AppNavView) => void }): JSX.Element {
  const [repoUrl, setRepoUrl] = useState("");
  const [testCommand, setTestCommand] = useState("");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [publishPr, setPublishPr] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, GateNotice>>({});
  const [repoError, setRepoError] = useState<string | null>(null);
  const [testCommandError, setTestCommandError] = useState<string | null>(null);

  const launch = async (gate: GateDef) => {
    const testCommandArgv = testCommand.split(/\s+/).filter(Boolean);
    if (testCommandArgv.length > 8) {
      setTestCommandError("Use no more than 8 arguments.");
      return;
    }
    setTestCommandError(null);
    const repo = repoUrl.trim();
    if (!REPO_RE.test(repo)) {
      setRepoError("Enter a GitHub repo URL (https://github.com/owner/repo).");
      return;
    }
    setRepoError(null);
    setNotices((n) => {
      const next = { ...n };
      delete next[gate.id];
      return next;
    });
    const extra = extras[gate.id] ?? "";
    setBusyId(gate.id);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repo,
          task: gate.task(repo, extra),
          publishPullRequest: publishPr,
          ...(testCommandArgv.length > 0 ? { testCommand: testCommandArgv } : {}),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; approvalId?: string };
      setNotices((n) => ({
        ...n,
        [gate.id]: !response.ok
          ? { kind: "error", text: body.error ?? `Queue failed (${response.status}).` }
          : { kind: "ok", text: "Queued — a human approves before anything runs.", approvalId: body.approvalId },
      }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[#f6f4ed] text-[#222320] p-4 lg:p-8">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-6">
        <div className="border-b border-[#e0ded5] pb-4">
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Quality Gates</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-none bg-[#0000a8]/10 border border-[#0000a8]/30 text-[#1c1cc8]">
              Review · QA · Security
            </span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Typed entry points onto the same approval-gated sandbox pipeline. Every gate queues a run; a human still approves before a container starts.
          </p>
        </div>

        {/* Step 1 — the target every gate shares. */}
        <section className="border border-[#e0ded5] rounded-none bg-[#f1efe6] shadow-[2px_2px_0_var(--paper-shadow)] p-5 flex flex-col gap-2 transition-colors focus-within:border-[#0000a8]/30">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <label htmlFor="gate-repo-url" className={labelClass}>
              <span className="text-[#6a6f63] font-mono mr-1.5">1</span> Repository
            </label>
            <label className="flex items-center gap-2 text-xs text-[#6a6f63] hover:text-[#222320] cursor-pointer select-none transition-colors">
              <input
                type="checkbox"
                checked={publishPr}
                onChange={(e) => setPublishPr(e.target.checked)}
                className="accent-[#0000a8] cursor-pointer"
              />
              Publish result as a PR
            </label>
          </div>
          <input
            id="gate-repo-url"
            type="text"
            aria-invalid={repoError !== null}
            aria-describedby={repoError ? "gate-repo-error" : "gate-repo-hint"}
            value={repoUrl}
            onChange={(e) => {
              setRepoUrl(e.target.value);
              if (repoError) setRepoError(null);
            }}
            placeholder="https://github.com/owner/repo"
            className={`${inputClass} ${repoError ? "border-[#fb2c36] focus:border-[#fb2c36] focus:ring-[#fb2c36]/30" : ""}`}
          />
          {repoError ? (
            <p id="gate-repo-error" role="alert" className="text-[11px] font-mono text-[#fb2c36]">
              {repoError}
            </p>
          ) : (
            <p id="gate-repo-hint" className="text-[11px] text-[#6a6f63]">
              Each gate below queues a sandbox run against this repo.
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label htmlFor="gate-test-command" className={labelClass}>
              Test command <span className="font-normal text-[#6a6f63]">(optional)</span>
            </label>
            <input
              id="gate-test-command"
              type="text"
              aria-invalid={testCommandError !== null}
              aria-describedby={testCommandError ? "gate-test-command-error" : undefined}
              value={testCommand}
              onChange={(e) => {
                setTestCommand(e.target.value);
                if (testCommandError) setTestCommandError(null);
              }}
              placeholder="pnpm test"
              className={`${inputClass} ${testCommandError ? "border-[#fb2c36] focus:border-[#fb2c36] focus:ring-[#fb2c36]/30" : ""}`}
            />
            {testCommandError ? (
              <p id="gate-test-command-error" role="alert" className="text-[11px] font-mono text-[#fb2c36]">
                {testCommandError}
              </p>
            ) : null}
          </div>
        </section>

        {/* Step 2 — the gate to queue. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {GATES.map((gate) => {
            const notice = notices[gate.id];
            return (
              <section
                key={gate.id}
                className="border border-[#e0ded5] hover:border-[#d3d2c8] rounded-none bg-[#f1efe6] shadow-[2px_2px_0_var(--paper-shadow)] p-5 flex flex-col gap-3 transition-colors"
              >
                <h3 className="text-sm font-semibold text-[#222320] flex items-center gap-2">
                  <span className="text-[#6a6f63] font-mono text-[11px]">2</span> {gate.name}
                </h3>
                <p className="text-[11px] text-[#6a6f63] leading-relaxed flex-1">{gate.description}</p>
                {gate.extraLabel ? (
                  <div className="flex flex-col gap-1">
                    <label htmlFor={`gate-extra-${gate.id}`} className={labelClass}>
                      {gate.extraLabel} <span className="font-normal text-[#6a6f63]">(optional)</span>
                    </label>
                    <input
                      id={`gate-extra-${gate.id}`}
                      type="text"
                      value={extras[gate.id] ?? ""}
                      onChange={(e) => setExtras((x) => ({ ...x, [gate.id]: e.target.value }))}
                      placeholder={gate.extraPlaceholder}
                      className={inputClass}
                    />
                  </div>
                ) : null}
                {notice ? (
                  <p
                    role={notice.kind === "error" ? "alert" : "status"}
                    className={`text-[11px] font-mono rounded-none px-2 py-1 border ${
                      notice.kind === "error"
                        ? "text-[#fb2c36] bg-[#fb2c36]/10 border-[#fb2c36]/30"
                        : "text-[#15803d] bg-[#15803d]/10 border-[#15803d]/30"
                    }`}
                  >
                    {notice.text}
                  </p>
                ) : null}
                <div className="flex items-center gap-3 flex-wrap">
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={() => void launch(gate)}
                    className="bg-[#0000a8] hover:bg-[#1c1cc8] text-white font-semibold py-1.5 px-4 rounded-none transition-all disabled:opacity-40 disabled:cursor-not-allowed text-xs flex items-center gap-1.5 shadow-[2px_2px_0_var(--paper-shadow)] active:translate-y-px"
                  >
                    {busyId === gate.id ? (
                      <>
                        <span className="animate-spin inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full" />
                        <span>Queueing…</span>
                      </>
                    ) : (
                      gate.actionLabel
                    )}
                  </button>
                  {notice?.kind === "ok" && onNavigate ? (
                    <button
                      type="button"
                      onClick={() => onNavigate("approvals")}
                      className="text-xs font-semibold text-[#1c1cc8] hover:text-[#0000a8] underline underline-offset-2 transition-colors"
                    >
                      Review the approval →
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}
