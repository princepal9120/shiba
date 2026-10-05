import { useCallback, useEffect, useState, type JSX } from "react";
import { toast } from "sonner";
import type { ComputerStatus, ConnectedComputer, PairingTokenResponse } from "@shiba/shared";
import { LoadErrorState } from "./LoadErrorState";

const POLL_MS = 10_000;

type FleetState =
  | { kind: "loading" }
  | { kind: "disabled" }
  | { kind: "error"; message: string }
  | { kind: "ready"; computers: ConnectedComputer[] };

type Identity = { kind: "checking" } | { kind: "ok"; agent: string } | { kind: "down"; message: string };

const STATUS_DOT: Record<ComputerStatus, string> = {
  idle: "bg-[#15803d]",
  busy: "bg-[#f99c00] animate-pulse",
  offline: "bg-[#6a6f63]/50",
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function PairingModal({ pairing, onClose }: { pairing: PairingTokenResponse; onClose: () => void }): JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.clearInterval(tick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const remaining = pairing.expiresAt - now;
  const expired = remaining <= 0;

  const copy = () => {
    navigator.clipboard.writeText(pairing.connectCommand).then(
      () => toast("Connect command copied"),
      () => toast.error("Copy failed — select the command and copy it manually"),
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-heading"
        className="w-full max-w-xl bg-[#fffef8] border border-[#e0ded5] rounded-none shadow-[2px_2px_0_var(--paper-shadow)] p-5 flex flex-col gap-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 id="pairing-heading" className="text-sm font-semibold text-[#222320]">Add computer</h3>
            <p className="text-xs text-[#6a6f63] mt-0.5">
              Run this on the machine you want to pair. The token works once; the daemon then connects outbound only.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-xs text-[#6a6f63] hover:text-[#222320] border border-[#e0ded5] px-2 py-1 rounded-none"
          >
            ✕
          </button>
        </div>
        <pre className="text-[11px] font-mono bg-[#f1efe6] border border-[#e0ded5] p-3 whitespace-pre-wrap break-all text-[#222320] select-all">
          {pairing.connectCommand}
        </pre>
        <div className="flex items-center justify-between gap-3">
          <span className={`text-xs font-mono ${expired ? "text-[#b91c1c]" : "text-[#6a6f63]"}`} aria-live="polite">
            {expired ? "Token expired — close and generate a new one" : `Expires in ${countdown(remaining)}`}
          </span>
          <button
            type="button"
            onClick={copy}
            disabled={expired}
            className="text-xs font-semibold text-white bg-[#0000a8] hover:bg-[#1c1cc8] disabled:opacity-40 px-3 py-1.5 rounded-none transition-colors"
          >
            Copy command
          </button>
        </div>
      </div>
    </div>
  );
}

export function RemoteAccessView(): JSX.Element {
  const [fleet, setFleet] = useState<FleetState>({ kind: "loading" });
  const [identity, setIdentity] = useState<Identity>({ kind: "checking" });
  const [pairing, setPairing] = useState<PairingTokenResponse | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/computers", { cache: "no-store" });
      // 404: the Worker has no fleet routes because SHIBA_LOCAL_RUNTIME is off.
      if (res.status === 404) return setFleet({ kind: "disabled" });
      if (!res.ok) return setFleet({ kind: "error", message: `GET /api/computers failed with ${res.status}.` });
      const body = (await res.json()) as { computers?: ConnectedComputer[] };
      setFleet({ kind: "ready", computers: body.computers ?? [] });
    } catch {
      setFleet({ kind: "error", message: "Network error reaching /api/computers." });
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(poll);
  }, [load]);

  useEffect(() => {
    fetch("/api/whoami", { redirect: "manual", cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as { agent?: unknown } | null;
        setIdentity(
          res.ok && typeof body?.agent === "string"
            ? { kind: "ok", agent: body.agent }
            : { kind: "down", message: `GET /api/whoami returned ${res.status || "a redirect"}.` },
        );
      })
      .catch(() => setIdentity({ kind: "down", message: "Network error reaching /api/whoami." }));
  }, []);

  const addComputer = async () => {
    setPairingBusy(true);
    try {
      const res = await fetch("/api/computers/pairing-token", { method: "POST" });
      if (res.status === 503) throw new Error("Pairing is not configured — set PAIRING_SECRET or LOCAL_ADAPTER_TOKEN on the Worker.");
      if (!res.ok) throw new Error(`POST /api/computers/pairing-token failed with ${res.status}.`);
      setPairing((await res.json()) as PairingTokenResponse);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create a pairing token.");
    } finally {
      setPairingBusy(false);
    }
  };

  const revoke = async (machine: ConnectedComputer) => {
    setConfirmRevoke(null);
    try {
      const res = await fetch("/api/computers/revoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ machineId: machine.machineId }),
      });
      if (!res.ok) throw new Error(`Revoke failed with ${res.status}.`);
      toast(`Revoked ${machine.hostname}`);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Revoke failed.");
    }
  };

  const closePairing = useCallback(() => {
    setPairing(null);
    void load();
  }, [load]);

  const computers = fleet.kind === "ready" ? fleet.computers : [];
  const online = computers.filter((c) => c.status !== "offline").length;

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden bg-[#f6f4ed] text-[#222320]">
      <div className="border-b border-[#e0ded5] bg-[#f1efe6] px-4 lg:px-8 py-4 flex flex-wrap items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-semibold text-[#222320] flex items-center gap-2">
            <span>Remote Access</span>
            {fleet.kind === "ready" ? (
              <span className="text-xs font-mono px-2 py-0.5 rounded-none bg-[#15803d]/10 text-[#15803d] border border-[#15803d]/30">
                {online}/{computers.length} online
              </span>
            ) : null}
          </h2>
          <p className="text-xs text-[#6a6f63]">
            Pair local machines with one command. Daemons connect outbound — no open ports on your computer.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void addComputer()}
          disabled={fleet.kind !== "ready" || pairingBusy}
          className="text-xs font-semibold text-white bg-[#0000a8] hover:bg-[#1c1cc8] disabled:opacity-40 px-3 py-1.5 rounded-none transition-colors"
        >
          {pairingBusy ? "Generating…" : "Add computer"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 lg:p-8">
        <div className="max-w-6xl mx-auto flex flex-col gap-6">
          <section aria-labelledby="connections-heading" className="flex flex-col gap-3">
            <div className="pb-1 border-b border-[#e0ded5]">
              <h3 id="connections-heading" className="text-sm font-semibold text-[#222320]">Connections</h3>
            </div>
            <div className="bg-[#fffef8] border border-[#e0ded5] p-4 rounded-none shadow-[2px_2px_0_var(--paper-shadow)] grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
              <div className="flex items-center gap-2">
                <span
                  className={`size-2 rounded-full ${identity.kind === "ok" ? "bg-[#15803d]" : identity.kind === "down" ? "bg-[#fb2c36]" : "bg-[#6a6f63]/50"}`}
                  aria-hidden="true"
                />
                <span className="text-[#6a6f63]">Worker endpoint</span>
                <span className="font-mono text-[#222320] truncate">
                  {identity.kind === "ok" ? "reachable" : identity.kind === "down" ? identity.message : "checking…"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[#6a6f63]">Signed in as</span>
                <span className="font-mono text-[#222320] truncate">{identity.kind === "ok" ? identity.agent : "—"}</span>
              </div>
            </div>
          </section>

          <section aria-labelledby="computers-heading" className="flex flex-col gap-3">
            <div className="flex items-center justify-between pb-1 border-b border-[#e0ded5]">
              <h3 id="computers-heading" className="text-sm font-semibold text-[#222320]">Computers</h3>
              <span className="text-xs font-mono text-[#6a6f63]">
                {computers.length} paired · refreshes every {POLL_MS / 1000}s
              </span>
            </div>

            {fleet.kind === "loading" ? (
              <p className="text-xs text-[#6a6f63] py-6 text-center">Loading fleet…</p>
            ) : fleet.kind === "error" ? (
              <LoadErrorState message={fleet.message} onRetry={() => void load()} />
            ) : fleet.kind === "disabled" || computers.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 border border-dashed border-[#e0ded5] rounded-none bg-[#fffef8] text-center p-6">
                <h4 className="text-sm font-semibold text-[#222320]">
                  {fleet.kind === "disabled" ? "Local runtime is disabled" : "No computers paired"}
                </h4>
                <p className="text-xs text-[#6a6f63] max-w-sm mt-0.5">
                  {fleet.kind === "disabled" ? (
                    <>
                      Set <code className="font-mono">SHIBA_LOCAL_RUNTIME=1</code> on the Worker to pair local daemons.
                    </>
                  ) : (
                    "Use Add computer to generate a one-time connect command."
                  )}
                </p>
              </div>
            ) : (
              <ul className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {computers.map((c) => (
                  <li
                    key={c.machineId}
                    className="bg-[#fffef8] border border-[#e0ded5] p-4 rounded-none shadow-[2px_2px_0_var(--paper-shadow)] flex flex-col gap-2"
                  >
                    <div className="flex items-center gap-2">
                      <span className={`size-2 rounded-full shrink-0 ${STATUS_DOT[c.status]}`} title={c.status} aria-hidden="true" />
                      <span className="text-sm font-semibold text-[#222320] truncate flex-1">{c.hostname}</span>
                      <span className="text-[10px] font-mono uppercase text-[#6a6f63]">{c.status}</span>
                    </div>
                    <div className="text-[11px] font-mono text-[#6a6f63] flex flex-wrap gap-x-3">
                      <span>{c.platform}</span>
                      <span>v{c.daemonVersion}</span>
                      <span>seen {ago(c.lastHeartbeat)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {c.harnesses.length === 0 ? (
                        <span className="text-[10px] text-[#6a6f63]">no harnesses detected</span>
                      ) : (
                        c.harnesses.map((h) => (
                          <span
                            key={h}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded-none bg-[#0000a8]/10 text-[#0000a8] border border-[#0000a8]/20"
                          >
                            {h}
                          </span>
                        ))
                      )}
                    </div>
                    <div className="flex justify-end gap-2 pt-1">
                      {confirmRevoke === c.machineId ? (
                        <>
                          <span className="text-[11px] text-[#b91c1c] self-center">Revoke {c.hostname}?</span>
                          <button
                            type="button"
                            onClick={() => setConfirmRevoke(null)}
                            className="text-xs text-[#222320] bg-[#fffef8] hover:bg-[#e0ded5] border border-[#e0ded5] px-2.5 py-1 rounded-none"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => void revoke(c)}
                            className="text-xs font-semibold text-white bg-[#b91c1c] hover:bg-[#fb2c36] px-2.5 py-1 rounded-none"
                          >
                            Confirm revoke
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRevoke(c.machineId)}
                          className="text-xs text-[#b91c1c] border border-[#fb2c36]/30 bg-[#fb2c36]/5 hover:bg-[#fb2c36]/10 px-2.5 py-1 rounded-none"
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>

      {pairing ? <PairingModal pairing={pairing} onClose={closePairing} /> : null}
    </div>
  );
}
