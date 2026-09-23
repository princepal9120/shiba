/**
 * MemoryTab — workspace-pane view of the agent's long-term memory: banked
 * facts and recorded sessions from the Memory DO (megaplan T8/T9 contract).
 * ?q= runs recall (ranked by score); an empty box lists facts plainly.
 * Forget is a two-step confirm — it deletes the fact for good.
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { MemoryFact, MemorySession } from "../types";
import { formatTimeAgo } from "../ui-helpers";

const GHOST_BUTTON =
  "text-[11px] bg-transparent hover:bg-white border border-slate-200 hover:border-slate-300 text-slate-500 hover:text-slate-900 font-medium py-1 px-2.5 rounded-md transition-colors";
const ACCENT_BUTTON =
  "text-[11px] bg-blue-600/10 hover:bg-blue-600/15 border border-[#0000a8]/15 text-blue-600 font-medium py-1 px-2.5 rounded-md transition-colors";
const DANGER_BUTTON =
  "text-[11px] bg-transparent hover:bg-[#fb2c36]/10 border border-[#fb2c36]/50 text-[#fb2c36] font-medium py-1 px-2.5 rounded-md transition-colors";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

/** Where a fact was learned from — the only provenance the UI shows. */
function sourceChipClass(source: string): string {
  switch (source) {
    case "run":
      return "text-blue-600 border-[#0000a8]/30 bg-blue-600/10";
    case "email":
      return "text-[#b45309] border-[#f99c00]/40 bg-[#f99c00]/10";
    default:
      return "text-slate-500 border-slate-200 bg-white";
  }
}

export function MemoryTab(): JSX.Element {
  const [facts, setFacts] = useState<MemoryFact[]>([]);
  const [sessions, setSessions] = useState<MemorySession[]>([]);
  const [query, setQuery] = useState("");
  const [searchActive, setSearchActive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState<string | null>(null);
  const [forgetBusy, setForgetBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [factsBody, sessionsBody] = await Promise.all([
        apiJson<{ facts?: MemoryFact[] }>("/api/memory/facts"),
        apiJson<{ sessions?: MemorySession[] }>("/api/memory/sessions"),
      ]);
      setFacts(Array.isArray(factsBody.facts) ? factsBody.facts : []);
      setSessions(Array.isArray(sessionsBody.sessions) ? sessionsBody.sessions : []);
      setSearchActive(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runRecall = useCallback(async () => {
    const q = query.trim();
    if (q === "") return;
    setSearching(true);
    setError(null);
    try {
      const body = await apiJson<{ facts?: MemoryFact[] }>(
        `/api/memory/facts?q=${encodeURIComponent(q)}`,
      );
      setFacts(Array.isArray(body.facts) ? body.facts : []);
      setSearchActive(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }, [query]);

  const forgetFact = useCallback(async (factId: string) => {
    setForgetBusy(factId);
    setError(null);
    try {
      await apiJson(`/api/memory/facts/${encodeURIComponent(factId)}`, { method: "DELETE" });
      setFacts((prev) => prev.filter((fact) => fact.id !== factId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setForgetBusy(null);
      setConfirmForget(null);
    }
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void runRecall();
        }}
        className="flex items-center gap-2"
      >
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Recall a fact…"
          className="flex-1 min-w-0 text-[11px] font-mono bg-white border border-slate-200 rounded-md px-2 py-1.5 text-slate-900 placeholder:text-slate-500 focus:outline-none focus:border-[#0000a8]/50"
        />
        <button type="submit" disabled={searching} className={ACCENT_BUTTON}>
          {searching ? "Recalling…" : "Recall"}
        </button>
        {searchActive ? (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              void load();
            }}
            className="text-[11px] text-slate-500 hover:text-slate-900"
          >
            Clear
          </button>
        ) : null}
      </form>

      {error !== null ? (
        <p className="text-[11px] text-[#fb2c36] bg-[#fb2c36]/10 border border-[#fb2c36]/20 rounded-lg px-2.5 py-2">
          {error}
        </p>
      ) : null}

      <div className="flex flex-col gap-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
          {searchActive ? "Recall results" : "Facts"}
        </h4>
        {loading ? (
          <div className="flex flex-col items-center justify-center py-8 border border-dashed border-slate-200 rounded-xl bg-[#f8fafc] px-4 text-center">
            <p className="text-slate-500 text-xs">Loading memory…</p>
          </div>
        ) : facts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 border border-dashed border-slate-200 rounded-xl bg-[#f8fafc] px-4 text-center">
            <p className="text-slate-500 text-xs">
              {searchActive ? "Nothing recalled." : "No facts banked yet."}
            </p>
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {facts.map((fact) => (
              <li
                key={fact.id}
                className="border border-slate-200 rounded-xl bg-[#f8fafc] p-3"
              >
                <pre className="font-mono text-[11px] text-slate-900 whitespace-pre-wrap break-words mb-2">
                  {fact.fact}
                </pre>
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`text-[10px] font-bold uppercase tracking-wider border rounded-full px-2 py-0.5 ${sourceChipClass(fact.source)}`}
                  >
                    {fact.source}
                  </span>
                  <span className="text-[10px] font-mono text-slate-500">{fact.agent}</span>
                  <span className="text-[10px] font-mono text-slate-500">
                    {formatTimeAgo(fact.created_at)}
                  </span>
                  {typeof fact.score === "number" ? (
                    <span className="text-[10px] font-mono text-blue-600">
                      {fact.score.toFixed(2)}
                    </span>
                  ) : null}
                  <span className="flex-1" />
                  {confirmForget === fact.id ? (
                    <>
                      <button
                        type="button"
                        className={DANGER_BUTTON}
                        disabled={forgetBusy === fact.id}
                        onClick={() => void forgetFact(fact.id)}
                      >
                        {forgetBusy === fact.id ? "Forgetting…" : "Confirm forget"}
                      </button>
                      <button
                        type="button"
                        className={GHOST_BUTTON}
                        onClick={() => setConfirmForget(null)}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className={GHOST_BUTTON}
                      onClick={() => setConfirmForget(fact.id)}
                    >
                      Forget
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-500 border-t border-slate-200 pt-3">
          Sessions
        </h4>
        {!loading && sessions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 border border-dashed border-slate-200 rounded-xl bg-[#f8fafc] px-4 text-center">
            <p className="text-slate-500 text-xs">No sessions recorded.</p>
          </div>
        ) : (
          <ol className="flex flex-col gap-2">
            {sessions.map((session) => {
              const expanded = expandedSession === session.id;
              return (
                <li
                  key={session.id}
                  className={`border rounded-xl bg-[#f8fafc] overflow-hidden transition-colors ${
                    expanded ? "border-[#0000a8]/50" : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setExpandedSession(expanded ? null : session.id)}
                    className="w-full text-left p-3 hover:bg-white transition-colors flex items-center gap-2"
                  >
                    <svg
                      className={`w-3.5 h-3.5 text-slate-500 transition-transform shrink-0 ${expanded ? "rotate-90" : ""}`}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="font-mono text-[11px] text-slate-900 truncate">{session.agent}</span>
                    <span className="text-[10px] font-mono text-slate-500 shrink-0 ml-auto">
                      {formatTimeAgo(session.started_at)}
                    </span>
                  </button>
                  {expanded ? (
                    <pre className="mx-3 mb-3 font-mono text-[11px] text-slate-900 bg-white p-2.5 rounded-lg border border-slate-200 whitespace-pre-wrap break-words max-h-40 overflow-auto">
                      {session.summary}
                    </pre>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
