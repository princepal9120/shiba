/**
 * Session distillation (megaplan task 10): when a retained run reaches a
 * terminal `completed`/`error` state, its transcript is summarized through
 * the orchestrator model into long-term memory — up to 10 durable facts
 * banked on the orchestrator's Memory DO stub plus one session row on the
 * shared `global` registry.
 *
 * Best-effort by contract: the orchestrator dispatches this under
 * `ctx.waitUntil` behind the `MEMORY_ENABLED` flag, wrapped in try/catch —
 * any failure (model, stub, store) logs and never fails the run.
 */
import type { Env } from "./env.js";
import { MEMORY_REGISTRY_NAME, memoryRegistryStub, memoryStub } from "./memory-do.js";
import type { DelegatedRun } from "./runs.js";
import { boundTail, redactSecrets } from "./security.js";

/** Head-bound for prose (facts, summaries, transcript) — the start carries the meaning. */
function boundHead(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}…[truncated]`;
}

/** Workers AI id the orchestrator plans and distills with. */
export const DEFAULT_ORCHESTRATOR_MODEL = "@cf/meta/llama-3.1-8b-instruct";

/** Spec cap: at most 10 durable facts per distilled session. */
export const MAX_DISTILL_FACTS = 10;

/** Model output is untrusted input — bound what reaches the store. */
const MAX_FACT_CHARS = 500;
const MAX_SUMMARY_CHARS = 2000;

/** Transcript bound — the model only ever sees this much of a run. */
const MAX_TRANSCRIPT_CHARS = 16_000;
const MAX_TRANSCRIPT_DIFF_CHARS = 8_000;
const MAX_TRANSCRIPT_RECEIPTS = 8;

/** Owning bank when the caller cannot name one (tests, unnamed DOs). */
const DEFAULT_AGENT = "orchestrator";

const ROUTE_BASE = "https://internal/internal/memory";

/** `MEMORY_ENABLED` kill switch. Unset means enabled; "false"/"0"/"off"/"no" disable. */
export function memoryEnabled(value: string | undefined): boolean {
  if (value === undefined || value.trim() === "") return true;
  return !["false", "0", "off", "no"].includes(value.trim().toLowerCase());
}

/**
 * The transcript a run distills from — task, repo, status, bounded
 * summary/error/diff, and a receipt tail. Pure so the input shaping is
 * unit-testable without the model or the store.
 */
export function runTranscript(run: DelegatedRun): string {
  const lines = [
    `Task: ${run.task}`,
    `Repository: ${run.repoUrl} (${run.baseBranch})`,
    `Run: ${run.runId}`,
    `Status: ${run.status}${run.errorCode ? ` (${run.errorCode})` : ""}`,
  ];
  if (run.summary) lines.push(`Summary: ${run.summary}`);
  if (run.error) lines.push(`Error: ${run.error}`);
  for (const receipt of (run.receipts ?? []).slice(-MAX_TRANSCRIPT_RECEIPTS)) {
    lines.push(`[${receipt.kind}] ${receipt.message}`);
  }
  // The diff is last and tail-bounded: an over-long transcript truncates
  // diff hunks first, never the task/status the model needs for context.
  if (run.diff) {
    lines.push("Diff:", boundTail(run.diff, MAX_TRANSCRIPT_DIFF_CHARS));
  }
  return boundHead(lines.join("\n"), MAX_TRANSCRIPT_CHARS);
}

/** Model output contract — validated defensively, never trusted. */
export interface DistilledMemory {
  facts: string[];
  summary: string;
}

/** Extract the text an instruct model returned ({response} or {response: {…}}). */
function responseText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const response = (result as { response?: unknown }).response;
  if (typeof response === "string") return response;
  if (response !== undefined) return JSON.stringify(response);
  return "";
}

/**
 * Parse the model's JSON out of whatever it actually returned — tolerates
 * prose around the object, markdown fences, missing fields, and non-string
 * entries. Secret-shaped strings are redacted here so a token the model
 * echoed back never reaches persisted memory. Returns null when no usable
 * object is present.
 */
export function parseDistilled(result: unknown): DistilledMemory | null {
  const text = responseText(result);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const body = parsed as { facts?: unknown; summary?: unknown };
  const facts = (Array.isArray(body.facts) ? body.facts : [])
    .filter((fact): fact is string => typeof fact === "string")
    .map((fact) => fact.trim())
    .filter((fact) => fact !== "")
    .slice(0, MAX_DISTILL_FACTS)
    .map((fact) => boundHead(redactSecrets(fact), MAX_FACT_CHARS));
  const summary =
    typeof body.summary === "string" && body.summary.trim() !== ""
      ? boundHead(redactSecrets(body.summary.trim()), MAX_SUMMARY_CHARS)
      : "";
  if (facts.length === 0 && summary === "") return null;
  return { facts, summary: summary || facts.join(" ") };
}

/**
 * The distillation prompt. Facts are durable knowledge only — what the run
 * did, durable outcomes, reusable learnings — never secrets, diffs, or
 * one-off state. One-paragraph summary doubles as the session record.
 */
function distillPrompt(transcript: string): string {
  return [
    "Distill this coding-agent run transcript into long-term memory.",
    `Reply with ONLY a JSON object {"summary": string, "facts": string[]} — at most ${MAX_DISTILL_FACTS} durable facts (short single sentences: what was done, durable outcomes, reusable knowledge; no secrets, no diff hunks) and a one-paragraph session summary.`,
    "",
    transcript,
  ].join("\n");
}

/**
 * Deterministic fact id — a replayed distillation banks the same ids, so
 * the store's 409 dedupe makes replays idempotent instead of doubling facts.
 * "/" and the route-shadowing "search" are the only unsafe values.
 */
function distillFactId(runId: string, index: number): string {
  const safe = runId.replaceAll("/", "_") || "run";
  return `distill_${safe}_${index}`;
}

/** The Memory partition a run banks into — never the reserved registry name. */
function distillAgent(name: string | undefined): string {
  const agent = name?.trim() || DEFAULT_AGENT;
  return agent === MEMORY_REGISTRY_NAME ? DEFAULT_AGENT : agent;
}

export interface DistillResult {
  distilled: boolean;
  factsBanked: number;
  sessionRecorded: boolean;
}

/**
 * Bank one distilled fact on the agent's stub. A 409 means the id is
 * already banked (a replay) — counted, not fatal. Other failures log and
 * the remaining facts still try.
 */
async function bankFact(env: Env, agent: string, id: string, fact: string): Promise<boolean> {
  const res = await memoryStub(env, agent).fetch(
    new Request(`${ROUTE_BASE}/facts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, fact, source: "run" }),
    }),
  );
  if (res.status === 409) {
    return true;
  }
  if (!res.ok) {
    console.warn(`memory_distill_bank_failed ${JSON.stringify({ id, status: res.status })}`);
    return false;
  }
  return true;
}

/**
 * Record the session row on the shared registry. `id` is the run id, so a
 * replayed distillation is a no-op (409) rather than a second session.
 */
async function recordSession(env: Env, run: DelegatedRun, agent: string, summary: string): Promise<boolean> {
  const res = await memoryRegistryStub(env).fetch(
    new Request(`${ROUTE_BASE}/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: run.runId,
        agent,
        summary,
        started_at: run.createdAt,
      }),
    }),
  );
  if (res.status === 409) {
    return true;
  }
  if (!res.ok) {
    console.warn(`memory_distill_session_failed ${JSON.stringify({ runId: run.runId, status: res.status })}`);
    return false;
  }
  return true;
}

/**
 * Distill one retained terminal run into long-term memory. Best-effort
 * end to end: the flag gates everything, a model failure ends the run of
 * work cleanly, and per-store failures are logged without aborting the
 * rest — this function never throws.
 */
export async function distillSession(
  env: Env,
  run: DelegatedRun,
  opts: { agent?: string } = {},
): Promise<DistillResult> {
  const empty: DistillResult = { distilled: false, factsBanked: 0, sessionRecorded: false };
  if (!memoryEnabled(env.MEMORY_ENABLED)) {
    return empty;
  }
  const agent = distillAgent(opts.agent);
  let distilled: DistilledMemory | null;
  try {
    const result = await env.AI.run(env.ORCHESTRATOR_MODEL || DEFAULT_ORCHESTRATOR_MODEL, {
      messages: [{ role: "user", content: distillPrompt(runTranscript(run)) }],
    });
    distilled = parseDistilled(result);
  } catch (error) {
    console.error(`Session distillation model call failed for ${run.runId}`, redactSecrets(String(error)));
    return empty;
  }
  if (distilled === null) {
    console.warn(`Session distillation returned no usable output for ${run.runId}`);
    return empty;
  }
  let factsBanked = 0;
  for (const [index, fact] of distilled.facts.entries()) {
    try {
      if (await bankFact(env, agent, distillFactId(run.runId, index), fact)) {
        factsBanked += 1;
      }
    } catch (error) {
      console.warn(
        `memory_distill_bank_failed ${JSON.stringify({
          runId: run.runId,
          error: error instanceof Error ? error.message : String(error),
        })}`,
      );
    }
  }
  let sessionRecorded = false;
  try {
    sessionRecorded = await recordSession(env, run, agent, distilled.summary);
  } catch (error) {
    console.warn(
      `memory_distill_session_failed ${JSON.stringify({
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error),
      })}`,
    );
  }
  return { distilled: true, factsBanked, sessionRecorded };
}
