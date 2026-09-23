/**
 * AuditPanel — "Audit log" section inside the Approvals tab (megaplan T13):
 * the newest MCP tool calls from the D1 audit store, newest first. Mono +
 * muted per the brief; non-ok outcomes keep a quiet status tint.
 * `args_hash` is a SHA-256 fingerprint — never the args — so it can be
 * shown verbatim (truncated for width, full value in the tooltip).
 */
import { useCallback, useEffect, useState, type JSX } from "react";
import type { AuditEntry } from "../types";
import { formatTimeAgo } from "../ui-helpers";

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed: ${response.status}`);
  }
  return body;
}

/** Muted default; non-ok outcomes get a quiet status tint. */
function outcomeClass(outcome: string): string {
  if (outcome === "error") return "text-[#fb2c36]";
  if (outcome === "denied") return "text-[#b45309]";
  return "text-[#6a6f63]";
}

export function AuditPanel(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await apiJson<{ entries?: AuditEntry[] }>("/api/audit?limit=200");
      setEntries(Array.isArray(body.entries) ? body.entries : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#6a6f63] border-t border-[#e0ded5] pt-3 flex items-center justify-between">
        <span>Audit log</span>
        <button
          type="button"
          onClick={() => void load()}
          title="Refresh audit log"
          className="text-[11px] text-[#6a6f63] hover:text-[#222320] font-normal normal-case tracking-normal transition-colors"
        >
          Refresh
        </button>
      </h4>

      {error !== null ? (
        <p className="text-[11px] text-[#fb2c36] bg-[#fb2c36]/10 border border-[#fb2c36]/20 rounded-lg px-2.5 py-2">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-6 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
          <p className="text-[#6a6f63] text-xs">Loading audit log…</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-6 border border-dashed border-[#e0ded5] rounded-xl bg-[#f6f4ed] px-4 text-center">
          <p className="text-[#6a6f63] text-xs">No audited tool calls yet.</p>
        </div>
      ) : (
        <div className="overflow-x-auto border border-[#e0ded5] rounded-xl bg-[#f6f4ed]">
          <table className="w-full text-[10px] font-mono text-[#6a6f63]">
            <thead>
              <tr className="border-b border-[#e0ded5] text-left">
                <th className="px-2 py-1.5 font-medium">ts</th>
                <th className="px-2 py-1.5 font-medium">principal</th>
                <th className="px-2 py-1.5 font-medium">tool</th>
                <th className="px-2 py-1.5 font-medium">outcome</th>
                <th className="px-2 py-1.5 font-medium">args_hash</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-[#e0ded5]/60 last:border-b-0">
                  <td
                    className="px-2 py-1.5 whitespace-nowrap"
                    title={new Date(entry.ts).toISOString()}
                  >
                    {formatTimeAgo(entry.ts)}
                  </td>
                  <td className="px-2 py-1.5 max-w-[90px] truncate" title={entry.principal}>
                    {entry.principal}
                  </td>
                  <td className="px-2 py-1.5 max-w-[110px] truncate" title={entry.tool}>
                    {entry.tool}
                  </td>
                  <td className={`px-2 py-1.5 ${outcomeClass(entry.outcome)}`}>
                    {entry.outcome}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap" title={entry.args_hash}>
                    {entry.args_hash.slice(0, 12)}…
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
