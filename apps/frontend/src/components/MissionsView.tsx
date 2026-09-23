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
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[#f8fafc] text-slate-900 p-4 lg:p-8">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-6">
        <div className="border-b border-slate-200 pb-4">
          <h2 className="text-base font-semibold text-slate-900 flex items-center gap-2">
            <span>Missions</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-blue-600/10 border border-[#0000a8]/30 text-blue-600">
              Standing goals
            </span>
          </h2>
          <p className="text-xs text-slate-500">
            A mission is a goal that persists across days: each cadence, a gate judges whether work remains and queues a run only while it does. Every run stays approval-gated.
          </p>
        </div>

        {notice ? (
          <div className="text-xs font-mono text-[#b45309] bg-[#b45309]/10 border border-[#b45309]/30 rounded-lg px-3 py-2">
            {notice}
          </div>
        ) : null}

        {/* New mission */}
        <div className="border border-slate-200 rounded-xl bg-white shadow-sm p-5 flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-slate-900">New Mission</h3>
          <textarea
            aria-label="Mission goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Keep dependency vulnerabilities at zero and the test suite green on main"
            rows={3}
            className="w-full bg-white text-xs text-slate-900 border border-slate-200 rounded-lg p-3 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-slate-500/50 resize-y"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              aria-label="Repository URL"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 min-w-56 bg-white text-xs font-mono text-slate-900 border border-slate-200 rounded-lg px-3 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-slate-500/50"
            />
            <select
              aria-label="Run cadence"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="bg-white text-xs text-slate-900 border border-slate-200 rounded-lg px-2.5 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30"
            >
              {CADENCES.map((c) => (
                <option key={c.cron} value={c.cron}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deployMission()}
              className="text-xs font-semibold text-blue-600 border border-[#0000a8]/40 bg-blue-600/10 hover:bg-blue-600/20 rounded-md px-3 py-1.5 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {busy ? (
                <>
                  <span className="animate-spin inline-block w-3 h-3 border-2 border-[#1c1cc8] border-t-transparent rounded-full" />
                  <span>Deploying…</span>
                </>
              ) : (
                "Deploy mission"
              )}
            </button>
          </div>
        </div>

        {/* Active missions */}
        <div className="border border-slate-200 rounded-xl bg-white shadow-sm p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">Active Missions</h3>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-slate-500 hover:text-slate-900 hover:border-slate-300 border border-slate-200 rounded-md px-2 py-1 transition-colors"
            >
              Refresh
            </button>
          </div>
          {missions === null ? (
            <div className="flex items-center gap-2 text-xs text-slate-500 font-mono py-2">
              <span className="animate-spin inline-block w-3 h-3 border-2 border-[#6a6f63] border-t-transparent rounded-full" />
              <span>Loading…</span>
            </div>
          ) : missions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 border border-dashed border-slate-200 rounded-lg bg-[#f8fafc] text-center px-4">
              <p className="text-slate-500 text-xs">No missions yet — deploy one above.</p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-[#e0ded5]">
              {missions.map((m) => (
                <div key={m.id} className="py-3 flex items-start justify-between gap-3 hover:bg-white -mx-2 px-2 rounded-lg transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold text-slate-900">{m.id}</span>
                      <span className="text-[10px] font-mono text-blue-600 bg-blue-600/10 border border-[#0000a8]/30 px-1.5 py-0.5 rounded">
                        {m.triggers.find((t) => t.kind === "schedule")?.cron ?? "manual"}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded border ${
                          m.enabled
                            ? "text-[#15803d] border-[#15803d]/30 bg-[#15803d]/10"
                            : "text-slate-500 border-slate-200 bg-white"
                        }`}
                      >
                        {m.enabled ? "active" : "paused"}
                      </span>
                    </div>
                    <p className="text-xs text-slate-900 mt-1 leading-relaxed">
                      {m.prompt.replace(/^Standing goal: /, "").split("\n")[0]}
                    </p>
                    <p className="text-[11px] font-mono text-slate-500 mt-1">
                      {m.repoUrl} · check-ins: {m.runCount ?? 0}
                      {m.lastSkip ? ` · last gate: ${m.lastSkip.reason}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runNow(m.id)}
                    className="text-xs font-semibold border border-[#0000a8]/40 text-blue-600 bg-blue-600/10 hover:bg-blue-600/20 rounded-md px-2.5 py-1 shrink-0 transition-colors disabled:opacity-50"
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
