import { useCallback, useEffect, useState, type JSX } from "react";

interface MissionRecord {
  id: string;
  prompt: string;
  repoUrl: string;
  enabled: boolean;
  mission?: boolean;
  runCount?: number;
  lastTriggeredAt?: number;
  lastSkip?: { at: number; reason: string };
  triggers: { kind: string; cron?: string; runWhen?: string }[];
}

const CADENCES = [
  { label: "Hourly", cron: "0 * * * *" },
  { label: "Every 6h", cron: "0 */6 * * *" },
  { label: "Daily 03:00", cron: "0 3 * * *" },
  { label: "Weekly Mon 09:00", cron: "0 9 * * 1" },
];

/**
 * Missions — standing multi-day goals (Factory-style). A mission is a
 * recurring automation whose `runWhen` gate asks "is this goal still
 * unfinished?" each cadence — work re-queues only while it is.
 */
export function MissionsView(): JSX.Element {
  const [missions, setMissions] = useState<MissionRecord[] | null>(null);
  const [goal, setGoal] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [cron, setCron] = useState(CADENCES[2]!.cron);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    fetch("/api/automations")
      .then(async (r) => (r.ok ? ((await r.json()) as { automations?: MissionRecord[] }) : null))
      .then((body) => {
        setMissions((body?.automations ?? []).filter((a) => a.mission === true));
      })
      .catch(() => {});
  }, []);

  useEffect(refresh, [refresh]);

  const deployMission = async () => {
    if (!goal.trim() || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/.test(repoUrl.trim())) {
      setNotice("A goal and a GitHub repo URL are required.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/automations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: `Standing goal: ${goal.trim()}\n\nOn each run, assess what remains toward this goal, implement the next increment, and open a PR with it.`,
          repoUrl: repoUrl.trim(),
          mission: true,
          enabled: true,
          triggers: [
            {
              kind: "schedule",
              cron,
              runWhen: `the standing goal "${goal.trim().slice(0, 300)}" still has unfinished work or new relevant changes`,
            },
            { kind: "manual" },
          ],
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setNotice(body.error ?? `Deploy failed (${response.status}).`);
      } else {
        setNotice("Mission deployed — first check-in runs on the next cadence tick.");
        setGoal("");
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const runNow = async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(`/api/automations/${encodeURIComponent(id)}/run`, { method: "POST" });
      const body = (await response.json().catch(() => ({}))) as { fired?: number; error?: string };
      setNotice(!response.ok ? (body.error ?? `Trigger failed (${response.status}).`)
        : body.fired ? `Mission "${id}" fired — approval queued.`
        : `Skipped — the goal gate judged it not needed.`);
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto text-zinc-200">
      <div className="mx-auto max-w-5xl w-full px-6 py-5 flex flex-col gap-6">
        <div className="border-b border-white/[0.07] pb-4">
          <h2 className="text-sm font-semibold text-zinc-100 flex items-center gap-2">
            <span>Missions</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.10] text-zinc-300">
              Standing goals
            </span>
          </h2>
          <p className="text-[13px] text-zinc-500">
            A mission is a goal that persists across days: each cadence, a gate judges whether work remains and queues a run only while it does. Every run stays approval-gated.
          </p>
        </div>

        {notice ? (
          <div className="text-xs font-mono text-[#c9a227] bg-white/[0.04] border border-white/[0.10] rounded-lg px-3 py-2">
            {notice}
          </div>
        ) : null}

        {/* New mission */}
        <div className="border border-white/[0.07] rounded-lg bg-[#101013]  p-5 flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-zinc-200">New Mission</h3>
          <textarea
            aria-label="Mission goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Keep dependency vulnerabilities at zero and the test suite green on main"
            rows={3}
            className="w-full bg-[#101013] text-xs text-zinc-200 border border-white/[0.07] rounded-lg p-3 transition-colors focus:outline-none focus:border-[#0B9F95] focus:ring-1 focus:ring-[#0B9F95]/30 placeholder:text-zinc-500/50 resize-y"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              aria-label="Repository URL"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 min-w-56 bg-[#101013] text-xs font-mono text-zinc-200 border border-white/[0.07] rounded-lg px-3 py-1.5 transition-colors focus:outline-none focus:border-[#0B9F95] focus:ring-1 focus:ring-[#0B9F95]/30 placeholder:text-zinc-500/50"
            />
            <select
              aria-label="Run cadence"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="bg-[#101013] text-xs text-zinc-200 border border-white/[0.07] rounded-lg px-2.5 py-1.5 transition-colors focus:outline-none focus:border-[#0B9F95] focus:ring-1 focus:ring-[#0B9F95]/30"
            >
              {CADENCES.map((c) => (
                <option key={c.cron} value={c.cron}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deployMission()}
              className="text-xs font-semibold text-zinc-300 border border-white/[0.10] bg-white/[0.04] hover:bg-white/[0.07] rounded-md px-3 py-1.5 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy ? (
                <>
                  <span className="animate-spin inline-block w-3 h-3 border-2 border-[#2dd4bf] border-t-transparent rounded-md" />
                  <span>Deploying…</span>
                </>
              ) : (
                "Deploy mission"
              )}
            </button>
          </div>
        </div>

        {/* Active missions */}
        <div className="border border-white/[0.07] rounded-lg bg-[#101013]  p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-200">Active Missions</h3>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-zinc-500 hover:text-zinc-200 hover:border-white/[0.12] border border-white/[0.07] rounded-md px-2 py-1 transition-colors"
            >
              Refresh
            </button>
          </div>
          {missions === null ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500 font-mono py-2">
              <span className="animate-spin inline-block w-3 h-3 border-2 border-[#8b98a9] border-t-transparent rounded-md" />
              <span>Loading…</span>
            </div>
          ) : missions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 border border-white/[0.07] rounded-lg bg-black/20 text-center px-4">
              <p className="text-zinc-500 text-xs">No missions yet — deploy one above.</p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-[#1e2530]">
              {missions.map((m) => (
                <div key={m.id} className="py-3 flex items-start justify-between gap-3 hover:bg-[#101013] -mx-2 px-2 rounded-lg transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold text-zinc-200">{m.id}</span>
                      <span className="text-[10px] font-mono text-zinc-300 bg-white/[0.04] border border-white/[0.10] px-1.5 py-0.5 rounded">
                        {m.triggers.find((t) => t.kind === "schedule")?.cron ?? "manual"}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded-md border ${
                          m.enabled
                            ? "text-[#4cc38a] border-[#4cc38a]/30 bg-[#4cc38a]/10"
                            : "text-zinc-500 border-white/[0.07] bg-black"
                        }`}
                      >
                        {m.enabled ? "active" : "paused"}
                      </span>
                    </div>
                    <p className="text-xs text-zinc-200 mt-1 leading-relaxed">
                      {m.prompt.replace(/^Standing goal: /, "").split("\n")[0]}
                    </p>
                    <p className="text-[11px] font-mono text-zinc-500 mt-1">
                      {m.repoUrl} · check-ins: {m.runCount ?? 0}
                      {m.lastSkip ? ` · last gate: ${m.lastSkip.reason}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runNow(m.id)}
                    className="text-xs font-semibold border border-white/[0.10] text-zinc-300 bg-white/[0.04] hover:bg-white/[0.07] rounded-md px-2.5 py-1 shrink-0 transition-colors disabled:opacity-50"
                  >
                    Check in now
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
