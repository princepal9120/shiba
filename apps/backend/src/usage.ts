/**
 * T-usage: fold retained run records into daily token/cost aggregates for
 * `GET /api/usage`. Pure math over `DelegatedRun[]` — the route handler
 * fetches the records from the orchestrator DO and passes env + runs here.
 *
 * Bucketing is UTC by `updatedAt` (the stamp that lands when usage does).
 * Groups key on the frozen route's harness, the model's provider part, and
 * the route's declared purpose (the record's role) when present — a run
 * that predates route freezing groups under `null` for those fields.
 * Numbers are only ever what harnesses reported; a group field stays absent
 * until some run in it reported that field.
 */
import type { DelegatedRun, RunUsage } from "@shiba/shared";
import { mergeRunUsage } from "@shiba/shared";
import type { Env } from "./env.js";
import { providerOf } from "./harness/types.js";

/** `USAGE_BUDGET_USD` — the deployment's optional daily USD budget. */
export const USAGE_BUDGET_ENV = "USAGE_BUDGET_USD";
export const USAGE_DAYS_DEFAULT = 30;
export const USAGE_DAYS_MAX = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageGroupReport {
  /** Frozen route fields; null when the run predates route freezing. */
  harness: string | null;
  provider: string | null;
  /** The route's declared purpose — the record's role — when present. */
  role: string | null;
  /** Runs in this group that reported usage. */
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface UsageDayReport {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Runs that day that reported usage. */
  runs: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  groups: UsageGroupReport[];
}

export interface UsageReport {
  generatedAt: number;
  /** Buckets are UTC calendar days — the wire says so. */
  timezone: "UTC";
  /** Configured daily budget; null when USAGE_BUDGET_USD is unset/unusable. */
  budgetUsd: number | null;
  days: UsageDayReport[];
}

/** Optional daily budget: a non-negative number, else null. */
export function parseUsageBudget(env: Pick<Env, "USAGE_BUDGET_USD">): number | null {
  const raw = env.USAGE_BUDGET_USD?.trim();
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** `?days=` — bounded so a bogus query can't grow the report unboundedly. */
export function parseUsageDays(raw: string | null): number {
  const parsed = raw === null ? USAGE_DAYS_DEFAULT : Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return USAGE_DAYS_DEFAULT;
  return Math.min(Math.floor(parsed), USAGE_DAYS_MAX);
}

function usageOf(run: DelegatedRun): RunUsage | undefined {
  const usage = run.usage;
  if (
    usage !== undefined &&
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined || usage.costUsd !== undefined)
  ) {
    return usage;
  }
  return undefined;
}

export function aggregateUsageByDay(
  runs: DelegatedRun[],
  opts?: { days?: number; now?: number },
): UsageDayReport[] {
  const dayCount = opts?.days ?? USAGE_DAYS_DEFAULT;
  const now = opts?.now ?? Date.now();
  const todayStart = Date.UTC(
    new Date(now).getUTCFullYear(),
    new Date(now).getUTCMonth(),
    new Date(now).getUTCDate(),
  );
  const cutoff = todayStart - (dayCount - 1) * DAY_MS;
  const byDay = new Map<
    string,
    { runs: number; totals: RunUsage; groups: Map<string, UsageGroupReport> }
  >();
  for (const run of runs) {
    const usage = usageOf(run);
    if (usage === undefined || run.updatedAt < cutoff) continue;
    const date = new Date(run.updatedAt).toISOString().slice(0, 10);
    let day = byDay.get(date);
    if (day === undefined) {
      day = { runs: 0, totals: {}, groups: new Map() };
      byDay.set(date, day);
    }
    day.runs += 1;
    day.totals = mergeRunUsage(day.totals, usage) ?? {};
    const harness = run.route?.harness ?? null;
    const provider = providerOf(run.route?.modelId ?? "");
    const role = run.route?.purpose ?? null;
    const key = `${harness ?? ""}${provider ?? ""}${role ?? ""}`;
    let group = day.groups.get(key);
    if (group === undefined) {
      group = { harness, provider, role, runs: 0 };
      day.groups.set(key, group);
    }
    group.runs += 1;
    const merged = mergeRunUsage(group, usage);
    group.inputTokens = merged?.inputTokens;
    group.outputTokens = merged?.outputTokens;
    group.costUsd = merged?.costUsd;
  }
  return [...byDay.entries()]
    .map(([date, day]) => ({
      date,
      runs: day.runs,
      ...(day.totals.inputTokens !== undefined ? { inputTokens: day.totals.inputTokens } : {}),
      ...(day.totals.outputTokens !== undefined ? { outputTokens: day.totals.outputTokens } : {}),
      ...(day.totals.costUsd !== undefined ? { costUsd: day.totals.costUsd } : {}),
      groups: [...day.groups.values()].sort((a, b) => {
        const byHarness = (a.harness ?? "").localeCompare(b.harness ?? "");
        if (byHarness !== 0) return byHarness;
        const byProvider = (a.provider ?? "").localeCompare(b.provider ?? "");
        if (byProvider !== 0) return byProvider;
        return (a.role ?? "").localeCompare(b.role ?? "");
      }),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function buildUsageReport(
  runs: DelegatedRun[],
  env: Pick<Env, "USAGE_BUDGET_USD">,
  opts?: { days?: number; now?: number },
): UsageReport {
  const days = opts?.days ?? USAGE_DAYS_DEFAULT;
  return {
    generatedAt: opts?.now ?? Date.now(),
    timezone: "UTC",
    budgetUsd: parseUsageBudget(env),
    days: aggregateUsageByDay(runs, { days, now: opts?.now }),
  };
}
