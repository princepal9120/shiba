import { useCallback, useEffect, useState, type JSX } from "react";
import { LoadErrorState } from "./LoadErrorState";

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
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoadError(null);
    fetch("/api/automations")
      .then(async (r) => {
        if (!r.ok) throw new Error(`Missions could not be loaded (${r.status}).`);
        return (await r.json()) as { automations?: MissionRecord[] };
      })
      .then((body) => {
        setMissions((body.automations ?? []).filter((a) => a.mission === true));
      })
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Missions could not be loaded.");
      });
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
    } catch {
      setNotice("Deploy failed: the backend could not be reached.");
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
    } catch {
      setNotice("Trigger failed: the backend could not be reached.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full overflow-y-auto bg-[#f6f4ed] text-[#222320] p-4 lg:p-8">
      <div className="max-w-5xl mx-auto w-full flex flex-col gap-6">
        <div className="border-b border-[#e0ded5] pb-4">
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Missions</span>
            <span className="text-xs font-mono px-2 py-0.5 rounded-none bg-[#0000a8]/10 border border-[#0000a8]/30 text-[#1c1cc8]">
              Standing goals
            </span>
          </h2>
          <p className="text-xs text-[#6a6f63]">
            A mission is a goal that persists across days: each cadence, a gate judges whether work remains and queues a run only while it does. Every run stays approval-gated.
          </p>
        </div>

        {notice ? (
          <div className="text-xs font-mono text-[#b45309] bg-[#b45309]/10 border border-[#b45309]/30 rounded-none px-3 py-2">
            {notice}
          </div>
        ) : null}

        {/* New mission */}
        <div className="border border-[#e0ded5] rounded-none bg-[#f1efe6] shadow-[2px_2px_0_var(--paper-shadow)] p-5 flex flex-col gap-3">
          <h3 className="text-sm font-semibold text-[#222320]">New Mission</h3>
          <textarea
            aria-label="Mission goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Keep dependency vulnerabilities at zero and the test suite green on main"
            rows={3}
            className="w-full bg-[#fffef8] text-xs text-[#222320] border border-[#e0ded5] rounded-none p-3 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-[#6a6f63]/50 resize-y"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              aria-label="Repository URL"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              className="flex-1 min-w-56 bg-[#fffef8] text-xs font-mono text-[#222320] border border-[#e0ded5] rounded-none px-3 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30 placeholder:text-[#6a6f63]/50"
            />
            <select
              aria-label="Run cadence"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              className="bg-[#fffef8] text-xs text-[#222320] border border-[#e0ded5] rounded-none px-2.5 py-1.5 transition-colors focus:outline-none focus:border-[#0000a8] focus:ring-1 focus:ring-[#0000a8]/30"
            >
              {CADENCES.map((c) => (
                <option key={c.cron} value={c.cron}>{c.label}</option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy}
              onClick={() => void deployMission()}
              className="text-xs font-semibold text-[#1c1cc8] border border-[#0000a8]/40 bg-[#0000a8]/10 hover:bg-[#0000a8]/20 rounded-none px-3 py-1.5 transition-colors disabled:opacity-50 flex items-center gap-1.5"
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
        <div className="border border-[#e0ded5] rounded-none bg-[#f1efe6] shadow-[2px_2px_0_var(--paper-shadow)] p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[#222320]">Active Missions</h3>
            <button
              type="button"
              onClick={refresh}
              className="text-[11px] text-[#6a6f63] hover:text-[#222320] hover:border-[#d3d2c8] border border-[#e0ded5] rounded-none px-2 py-1 transition-colors"
            >
              Refresh
            </button>
          </div>
          {loadError !== null ? (
            <LoadErrorState message={loadError} onRetry={refresh} />
          ) : missions === null ? (
            <div className="flex items-center gap-2 text-xs text-[#6a6f63] font-mono py-2">
              <span className="animate-spin inline-block w-3 h-3 border-2 border-[#6a6f63] border-t-transparent rounded-full" />
              <span>Loading…</span>
            </div>
          ) : missions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#e0ded5] rounded-none bg-[#f6f4ed] text-center px-4">
              <p className="text-[#6a6f63] text-xs">No missions yet — deploy one above.</p>
            </div>
          ) : (
            <div className="flex flex-col divide-y divide-[#e0ded5]">
              {missions.map((m) => (
                <div key={m.id} className="py-3 flex items-start justify-between gap-3 hover:bg-[#fffef8] -mx-2 px-2 rounded-none transition-colors">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-mono font-semibold text-[#222320]">{m.id}</span>
                      <span className="text-[10px] font-mono text-[#1c1cc8] bg-[#0000a8]/10 border border-[#0000a8]/30 px-1.5 py-0.5 rounded-none">
                        {m.triggers.find((t) => t.kind === "schedule")?.cron ?? "manual"}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-1.5 py-0.5 rounded-none border ${
                          m.enabled
                            ? "text-[#15803d] border-[#15803d]/30 bg-[#15803d]/10"
                            : "text-[#6a6f63] border-[#e0ded5] bg-[#fffef8]"
                        }`}
                      >
                        {m.enabled ? "active" : "paused"}
                      </span>
                    </div>
                    <p className="text-xs text-[#222320] mt-1 leading-relaxed">
                      {m.prompt.replace(/^Standing goal: /, "").split("\n")[0]}
                    </p>
                    <p className="text-[11px] font-mono text-[#6a6f63] mt-1">
                      {m.repoUrl} · check-ins: {m.runCount ?? 0}
                      {m.lastSkip ? ` · last gate: ${m.lastSkip.reason}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void runNow(m.id)}
                    className="text-xs font-semibold border border-[#0000a8]/40 text-[#1c1cc8] bg-[#0000a8]/10 hover:bg-[#0000a8]/20 rounded-none px-2.5 py-1 shrink-0 transition-colors disabled:opacity-50"
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
