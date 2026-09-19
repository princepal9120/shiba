import { useCallback, useEffect, useState, type JSX } from "react";

interface AutomationRecord {
  id: string;
  prompt: string;
  repoUrl: string;
  enabled: boolean;
  runCount?: number;
  lastTriggeredAt?: number;
  lastSkip?: { at: number; reason: string };
  triggers: { kind: string }[];
}

/** Factory-style recipe gallery: each card is one automation ready to deploy. */
const RECIPES: {
  id: string;
  name: string;
  description: string;
  cadence: string;
  prompt: string;
  triggers: Record<string, unknown>[];
}[] = [
  {
    id: "pr-review",
    name: "PR Review on Open",
    description: "Exhaustive review on every pull request — correctness, regressions, and test gaps, posted as a PR.",
    cadence: "GitHub event",
    prompt:
      "Review the latest opened pull request in this repository. Check for correctness bugs, missing tests, and regressions. Fix any blocking issues you find and open a PR with the fixes.",
    triggers: [{ kind: "github", events: ["pull_request:opened"] }],
  },
  {
    id: "nightly-lint",
    name: "Nightly Lint Autofix",
    description: "Fix lint violations across the codebase every night and open a PR with the results.",
    cadence: "0 3 * * *",
    prompt:
      "Run the repository's linter. Fix every violation it reports — formatting, unused imports, dead code. Open a PR with the clean tree.",
    triggers: [{ kind: "schedule", cron: "0 3 * * *" }],
  },
  {
    id: "weekly-deps",
    name: "Weekly Dependency + Secret Sweep",
    description: "Audit dependencies for CVEs, scan for committed secrets, and bump what's safe — one PR per week.",
    cadence: "0 9 * * 1",
    prompt:
      "Audit dependencies for known vulnerabilities and committed secrets. Apply safe patch/minor bumps and remove any leaked credentials. Open a PR with the results.",
    triggers: [{ kind: "schedule", cron: "0 9 * * 1" }],
  },
  {
    id: "docs-sync",
    name: "Docs Sync",
    description: "Keep READMEs, JSDoc, and API references in sync with the code that shipped this week.",
    cadence: "0 4 * * 6",
    prompt:
      "Compare the docs (README, JSDoc, API references) against the code changed in the last week. Update stale sections and open a PR.",
    triggers: [{ kind: "schedule", cron: "0 4 * * 6" }],
  },
  {
    id: "oncall-triage",
    name: "On-Call Slack Triage",
    description: "Slack messages mentioning 'incident' or 'error' trigger a triage run — one run per burst.",
    cadence: "Slack event",
    prompt:
      "An incident was reported in Slack. Investigate the repository for the likely cause, write a fix or mitigation, and open a PR. Include a root-cause note in the PR description.",
    triggers: [{ kind: "slack", textContains: ["incident", "error", "down"], burstWindowSeconds: 60 }],
  },
  {
    id: "manual-audit",
    name: "Manual Deep Audit",
    description: "A full-repo audit you fire by hand from this page — the /run endpoint queues it for approval.",
    cadence: "Manual",
    prompt:
      "Audit this repository end to end: dead code, missing error handling, unsafe patterns, and inconsistent interfaces. Open a PR with the highest-impact fixes.",
    triggers: [{ kind: "manual" }],
  },
];

export function AutomationsView(): JSX.Element {
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);
  const [automations, setAutomations] = useState<AutomationRecord[] | null>(null);
  const [repoUrl, setRepoUrl] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const copyToClipboard = (text: string, label: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedEndpoint(label);
    setTimeout(() => setCopiedEndpoint(null), 2000);
  };

  const refresh = useCallback(() => {
    fetch("/api/automations")
      .then(async (r) => (r.ok ? ((await r.json()) as { automations?: AutomationRecord[] }) : null))
      .then((body) => {
        if (body?.automations) setAutomations(body.automations);
      })
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const deployRecipe = async (recipe: (typeof RECIPES)[number]) => {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(repoUrl.trim())) {
      setNotice("Enter a GitHub repo URL for the recipe target first.");
      return;
    }
    setBusyId(recipe.id);
    setNotice(null);
    try {
      const response = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: recipe.id,
          prompt: recipe.prompt,
          repoUrl: repoUrl.trim(),
          triggers: recipe.triggers,
          enabled: true,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice(body.error ?? `Deploy failed (${response.status}).`);
      } else {
        setNotice(`Deployed "${recipe.name}".`);
        refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  const triggerNow = async (id: string) => {
    setBusyId(`run-${id}`);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fired?: number;
        skipped?: number;
      };
      if (!response.ok) {
        setNotice(body.error ?? `Trigger failed (${response.status}).`);
      } else {
        setNotice(body.fired ? `Fired "${id}" — approval queued.` : `Skipped "${id}" — see lastSkip.`);
        refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[#0d1117] text-[#e6edf3] p-4 lg:p-8">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-6">
        {/* Header */}
        <div className="border-b border-white/[0.08] pb-4">
          <h2 className="text-base font-semibold text-white flex items-center gap-2">
            <span>Automations & Inbound Triggers</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-teal-950/60 border border-teal-800/60 text-teal-400">
              Autonomous
            </span>
          </h2>
          <p className="text-xs text-[#8b98a9]">
            AI Intern triggers tasks automatically from GitHub webhooks, Slack channels, and scheduled cron ticks.
          </p>
        </div>

        {notice ? (
          <div className="text-xs font-mono text-[#c9a227] bg-[#c9a227]/10 border border-[#c9a227]/30 rounded-lg px-3 py-2">
            {notice}
          </div>
        ) : null}

        {/* Recipe Gallery — deploy a standing agent in one click */}
        <div className="border border-white/[0.08] rounded-xl bg-[#07090e] shadow-sm p-5 flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Recipe Gallery</h3>
              <p className="text-xs text-[#8b98a9] mt-0.5">
                Each recipe is an agent on a trigger. Point it at a repo and deploy.
              </p>
            </div>
            <input
              type="text"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="bg-black text-xs font-mono text-[#e6edf3] border border-neutral-800 rounded-lg px-3 py-1.5 w-72 focus:outline-none focus:border-teal-500 placeholder:text-[#8b98a9]/50"
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {RECIPES.map((recipe) => {
              const deployed = automations?.some((a) => a.id === recipe.id) ?? false;
              return (
                <div
                  key={recipe.id}
                  className="bg-[#0d1117] p-4 rounded-lg border border-white/[0.08] flex flex-col gap-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-white">{recipe.name}</span>
                    <span className="text-[10px] font-mono text-teal-400 bg-teal-950/60 border border-teal-800/60 px-1.5 py-0.5 rounded whitespace-nowrap">
                      {recipe.cadence}
                    </span>
                  </div>
                  <p className="text-[11px] text-[#8b98a9] leading-relaxed flex-1">{recipe.description}</p>
                  <button
                    type="button"
                    disabled={busyId === recipe.id || deployed}
                    onClick={() => void deployRecipe(recipe)}
                    className="text-xs font-semibold self-start border rounded-md px-2.5 py-1 transition-colors disabled:opacity-50 text-teal-300 border-teal-500/40 bg-teal-950/50 hover:bg-teal-900/60"
                  >
                    {deployed ? "Deployed" : busyId === recipe.id ? "Deploying…" : "Deploy recipe"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live automations from the DO */}
        <div className="border border-white/[0.08] rounded-xl bg-[#07090e] shadow-sm p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white">Deployed Automations</h3>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-[#8b98a9] hover:text-white border border-neutral-800 rounded-md px-2 py-1"
            >
              Refresh
            </button>
          </div>
          {automations === null ? (
            <p className="text-xs text-[#8b98a9] font-mono">Loading…</p>
          ) : automations.length === 0 ? (
            <p className="text-xs text-[#8b98a9]">None yet — deploy a recipe above or POST /api/automations.</p>
          ) : (
            <div className="flex flex-col divide-y divide-white/[0.06]">
              {automations.map((a) => (
                <div key={a.id} className="py-2.5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-semibold text-white truncate">{a.id}</span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                          a.enabled
                            ? "text-[#4cc38a] border-[#4cc38a]/30 bg-[#4cc38a]/10"
                            : "text-[#8b98a9] border-neutral-800 bg-black"
                        }`}
                      >
                        {a.enabled ? "enabled" : "disabled"}
                      </span>
                      <span className="text-[10px] font-mono text-[#8b98a9]">
                        {a.triggers.map((t) => t.kind).join(" + ")}
                      </span>
                    </div>
                    <p className="text-[11px] text-[#8b98a9] truncate mt-0.5">
                      {a.repoUrl} · runs: {a.runCount ?? 0}
                      {a.lastSkip ? ` · last skip: ${a.lastSkip.reason}` : ""}
                    </p>
                  </div>
                  {a.triggers.some((t) => t.kind === "manual") ? (
                    <button
                      type="button"
                      disabled={busyId === `run-${a.id}`}
                      onClick={() => void triggerNow(a.id)}
                      className="text-xs font-semibold border border-teal-500/40 text-teal-300 bg-teal-950/50 hover:bg-teal-900/60 rounded-md px-2.5 py-1 shrink-0 disabled:opacity-50"
                    >
                      {busyId === `run-${a.id}` ? "Firing…" : "Run now"}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Integration Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* GitHub Webhook */}
          <div className="border border-white/[0.08] rounded-xl bg-[#07090e] shadow-sm p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-sm text-white">
                <svg className="w-5 h-5 text-teal-400" fill="currentColor" viewBox="0 0 24 24">
                  <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
                </svg>
                <span>GitHub Webhooks</span>
              </div>
              <span className="text-[10px] font-mono uppercase bg-[#4cc38a]/15 text-[#4cc38a] border border-[#4cc38a]/30 px-2 py-0.5 rounded-full">
                Signature Verified
              </span>
            </div>

            <p className="text-xs text-[#8b98a9] leading-relaxed">
              Receives repo events (issues, PRs, comments) and automatically dispatches coding jobs to sandboxes.
            </p>

            <div className="bg-[#0d1117] p-2.5 rounded-lg border border-white/[0.08] flex items-center justify-between text-xs font-mono">
              <span className="text-[#e6edf3] truncate">/api/github/webhook</span>
              <button
                type="button"
                onClick={() => copyToClipboard("/api/github/webhook", "github")}
                className="text-teal-400 hover:text-teal-300 text-[11px] shrink-0 ml-2"
              >
                {copiedEndpoint === "github" ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="text-[11px] font-mono text-[#8b98a9]">
              Secret: <span className="text-white">GITHUB_WEBHOOK_SECRET</span> (HMAC-SHA256)
            </div>
          </div>

          {/* Slack Integration */}
          <div className="border border-white/[0.08] rounded-xl bg-[#07090e] shadow-sm p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 font-semibold text-sm text-white">
                <svg className="w-5 h-5 text-teal-400" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521A2.528 2.528 0 0 1 2.522 8.834a2.528 2.528 0 0 1-2.522 2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1 2.521-2.52 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
                </svg>
                <span>Slack Bot & Interactive Gates</span>
              </div>
              <span className="text-[10px] font-mono uppercase bg-teal-950/60 text-teal-400 border border-teal-800/60 px-2 py-0.5 rounded-full">
                Interactive
              </span>
            </div>

            <p className="text-xs text-[#8b98a9] leading-relaxed">
              Mention <code className="text-white">@intern</code> or run <code className="text-white">/intern</code>. Approvals are posted as interactive Slack Block Kit cards.
            </p>

            <div className="flex flex-col gap-1.5 text-xs font-mono">
              <div className="bg-[#0d1117] p-2 rounded border border-white/[0.08] flex items-center justify-between">
                <span>Commands: /api/slack/command</span>
                <button type="button" onClick={() => copyToClipboard("/api/slack/command", "slack1")} className="text-teal-400 text-[11px]">
                  {copiedEndpoint === "slack1" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="bg-[#0d1117] p-2 rounded border border-white/[0.08] flex items-center justify-between">
                <span>Events: /api/slack/events</span>
                <button type="button" onClick={() => copyToClipboard("/api/slack/events", "slack2")} className="text-teal-400 text-[11px]">
                  {copiedEndpoint === "slack2" ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="bg-[#0d1117] p-2 rounded border border-white/[0.08] flex items-center justify-between">
                <span>Interactivity: /api/slack/interact</span>
                <button type="button" onClick={() => copyToClipboard("/api/slack/interact", "slack3")} className="text-teal-400 text-[11px]">
                  {copiedEndpoint === "slack3" ? "Copied" : "Copy"}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Automations DO Engine */}
        <div className="border border-white/[0.08] rounded-xl bg-[#07090e] shadow-sm p-5 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <svg className="w-4 h-4 text-teal-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Automations Durable Object Engine</span>
            </h3>
            <span className="text-[11px] font-mono text-[#4cc38a]">Active & Bound</span>
          </div>

          <p className="text-xs text-[#8b98a9] leading-relaxed">
            The Automations Durable Object maintains scheduled task timers, processes incoming event fan-outs, and triggers automated coding workflows with full telemetry and replay receipts.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 font-mono text-xs">
            <div className="bg-[#0d1117] p-3 rounded-lg border border-white/[0.08] flex flex-col gap-1">
              <span className="text-[#8b98a9] text-[11px]">Cron Scheduler</span>
              <span className="text-white font-semibold">Hourly Health Tick</span>
            </div>
            <div className="bg-[#0d1117] p-3 rounded-lg border border-white/[0.08] flex flex-col gap-1">
              <span className="text-[#8b98a9] text-[11px]">Evaluation Model</span>
              <span className="text-white font-semibold">TypeSafe System One / Llama</span>
            </div>
            <div className="bg-[#0d1117] p-3 rounded-lg border border-white/[0.08] flex flex-col gap-1">
              <span className="text-[#8b98a9] text-[11px]">Run Capacity</span>
              <span className="text-white font-semibold">5 Concurrent Sandboxes</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
