import { useState, type JSX } from "react";

interface GateDef {
  id: string;
  name: string;
  description: string;
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
    extraLabel: "PR number or branch (optional)",
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
    task: (repo) =>
      `Generate missing tests in ${repo}: find recently changed code paths without coverage, write unit/integration tests matching the repo's existing test style, run the suite, then run \`procoder check\` on the changed files and fix its findings, and open a PR with the additions.`,
  },
  {
    id: "security",
    name: "Security Review",
    description: "STRIDE + OWASP audit of the repository: injection paths, authz gaps, secret leakage, unsafe dependencies — fixed and shipped as a PR.",
    task: (repo) =>
      `Security-audit ${repo} against STRIDE and the OWASP Top 10: trace untrusted input to sinks, check authz boundaries, scan for committed secrets and vulnerable dependencies. Fix confirmed findings, run \`procoder check\` on the changed files, and open a PR.`,
  },
];

/**
 * Quality Gates — dedicated entry points for review, QA, and security runs.
 * Every gate queues a normal approval-gated run; nothing bypasses review.
 */
export function GatesView(): JSX.Element {
  const [repoUrl, setRepoUrl] = useState("");
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [publishPr, setPublishPr] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Record<string, string>>({});

  const launch = async (gate: GateDef) => {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(repoUrl.trim())) {
      setNotices((n) => ({ ...n, [gate.id]: "Enter a GitHub repo URL first." }));
      return;
    }
    const extra = extras[gate.id] ?? "";
    setBusyId(gate.id);
    try {
      const response = await fetch("/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: repoUrl.trim(),
          task: gate.task(repoUrl.trim(), extra),
          publishPullRequest: publishPr,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; approvalId?: string };
      setNotices((n) => ({
        ...n,
        [gate.id]: !response.ok
          ? (body.error ?? `Queue failed (${response.status}).`)
          : `Queued — approval ${body.approvalId?.slice(0, 8) ?? ""} pending.`,
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
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-[#0000a8]/10 border border-[#0000a8]/30 text-[#1c1cc8]">
              Review · QA · Security
            </span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Typed entry points onto the same approval-gated sandbox pipeline. Every gate queues a run; a human still approves before a container starts.
          </p>
        </div>

        <div className="border border-[#e0ded5] rounded-xl bg-[#f1efe6] shadow-sm p-5 flex flex-wrap items-center gap-3 transition-colors focus-within:border-[#0000a8]/30">
          <input
            type="text"
            aria-label="Repository URL"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            className="flex-1 min-w-56 bg-[#fffef8] text-xs font-mono text-[#222320] border border-[#e0ded5] rounded-lg px-3 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-[#6a6f63]/50"
          />
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

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {GATES.map((gate) => (
            <div
              key={gate.id}
              className="border border-[#e0ded5] hover:border-[#d3d2c8] rounded-xl bg-[#f1efe6] shadow-sm p-5 flex flex-col gap-3 transition-colors"
            >
              <h3 className="text-sm font-semibold text-[#222320]">{gate.name}</h3>
              <p className="text-[11px] text-[#6a6f63] leading-relaxed flex-1">{gate.description}</p>
              {gate.extraLabel ? (
                <input
                  type="text"
                  aria-label={gate.extraLabel}
                  value={extras[gate.id] ?? ""}
                  onChange={(e) => setExtras((x) => ({ ...x, [gate.id]: e.target.value }))}
                  placeholder={gate.extraPlaceholder}
                  className="w-full bg-[#fffef8] text-xs font-mono text-[#222320] border border-[#e0ded5] rounded-lg px-3 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-[#6a6f63]/50"
                />
              ) : null}
              {notices[gate.id] ? (
                <p className="text-[11px] font-mono text-[#b45309] bg-[#b45309]/10 border border-[#b45309]/20 rounded-md px-2 py-1">{notices[gate.id]}</p>
              ) : null}
              <button
                type="button"
                disabled={busyId === gate.id}
                onClick={() => void launch(gate)}
                className="text-xs font-semibold self-start text-[#1c1cc8] border border-[#0000a8]/40 bg-[#0000a8]/10 hover:bg-[#0000a8]/20 rounded-md px-2.5 py-1 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {busyId === gate.id ? (
                  <>
                    <span className="animate-spin inline-block w-3 h-3 border-2 border-[#1c1cc8] border-t-transparent rounded-full" />
                    <span>Queueing…</span>
                  </>
                ) : (
                  "Queue gate"
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
