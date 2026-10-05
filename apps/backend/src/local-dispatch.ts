/**
 * T51: LocalDispatch — the single-writer mailbox a local run flows through.
 *
 *   Worker (LocalRuntimeAdapter)            operator daemon (`shiba local`)
 *   ──────────────────────────              ──────────────────────────
 *   POST /dispatch {envelope}   ──►   pending
 *                                   ◄──  POST /claim {operator}  → {claimToken, envelope}
 *   GET /status?sandboxId  polls        POST /result {sandboxId, claimToken, result}
 *   until settled
 *   POST /cancel on abort
 *
 * One DO, one request at a time: claim is the single serialized point that
 * keeps two daemons from executing the same run. The claimToken minted here
 * (never caller-supplied) is the result-write credential — a daemon that
 * didn't win the claim cannot settle the record.
 *
 * Auth lives at the Worker front door (handleLocalAdapter): every request
 * reaching this DO is already flag-gated and bearer-checked, or is a
 * Worker-internal call from the adapter (dispatch/status/cancel carry no
 * bearer — the DO trusts the intra-deployment channel the same way the
 * orchestrator's https://internal routes do).
 */
import { DurableObject } from "cloudflare:workers";
import {
  LOCAL_CLAIM_STALE_MS,
  LOCAL_COMPUTER_PRUNE_MS,
  LOCAL_DISPATCH_DO_NAME,
  LOCAL_HEARTBEAT_STALE_MS,
  localRunEnvelopeSchema,
  localRunResultSchema,
  type ConnectedComputer,
  type LocalDispatchRecord,
  type LocalDispatchStatus,
} from "@shiba/shared";
import { sha256Hex } from "./agent-tokens.js";
import { HeartbeatRequestSchema, PairRequestSchema, decodeOrNull } from "./local-fleet-schema.js";
import { randomHex } from "./mailbox-store.js";

const RECORD_PREFIX = "run:";
const COMPUTER_PREFIX = "computer:";
/** `pair:<nonce>` → expiresAt; deleted on first use, so a pairing token mints once. */
const PAIR_PREFIX = "pair:";

/** Stored machine record: the adapter token lives only as its sha256 — never readable back. */
type ComputerRecord = Omit<ConnectedComputer, "status"> & { tokenHash?: string };

function toConnectedComputer({ tokenHash: _hash, ...record }: ComputerRecord, now: number): ConnectedComputer {
  const status = now - record.lastHeartbeat > LOCAL_HEARTBEAT_STALE_MS ? "offline" : record.activeRunId !== undefined ? "busy" : "idle";
  return { ...record, status };
}

export class LocalDispatch extends DurableObject {
  private async getRecord(sandboxId: string): Promise<LocalDispatchRecord | null> {
    return (await this.ctx.storage.get<LocalDispatchRecord>(`${RECORD_PREFIX}${sandboxId}`)) ?? null;
  }

  private async putRecord(record: LocalDispatchRecord): Promise<void> {
    await this.ctx.storage.put(`${RECORD_PREFIX}${record.envelope.sandboxId}`, record);
  }

  private async deleteRecord(sandboxId: string): Promise<void> {
    await this.ctx.storage.delete(`${RECORD_PREFIX}${sandboxId}`);
  }

  /**
   * A claimed record whose holder never settled is reaped past the run
   * deadline — the daemon may have died mid-run; the run row reclaims on
   * its own clock either way.
   */
  private async reapStaleClaims(now: number): Promise<void> {
    const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
    for (const record of records.values()) {
      if (record.status === "claimed" && record.claimedAt !== undefined && now - record.claimedAt > LOCAL_CLAIM_STALE_MS) {
        await this.putRecord({ ...record, status: "cancelled", claimToken: undefined, settledAt: now });
      }
      // Settled/cancelled records are audit tail — prune past 7 days.
      if ((record.status === "settled" || record.status === "cancelled") && now - (record.settledAt ?? record.envelope.createdAt) > 7 * 24 * 60 * 60 * 1000) {
        await this.deleteRecord(record.envelope.sandboxId);
      }
    }
    const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
    for (const [key, computer] of computers) {
      if (now - computer.lastHeartbeat > LOCAL_COMPUTER_PRUNE_MS) await this.ctx.storage.delete(key);
    }
    const nonces = await this.ctx.storage.list<number>({ prefix: PAIR_PREFIX });
    for (const [key, expiresAt] of nonces) {
      if (now > expiresAt) await this.ctx.storage.delete(key);
    }
  }

  private async json(request: Request): Promise<Record<string, unknown> | Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body is not valid JSON." }, { status: 400 });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    return body as Record<string, unknown>;
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    await this.reapStaleClaims(now);

    if (request.method === "POST" && url.pathname === "/dispatch") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const parsed = localRunEnvelopeSchema.safeParse(body.envelope);
      if (!parsed.success) {
        return Response.json({ error: "Invalid run envelope." }, { status: 400 });
      }
      const existing = await this.getRecord(parsed.data.sandboxId);
      if (existing !== null && existing.status !== "settled" && existing.status !== "cancelled") {
        return Response.json({ error: `Run ${parsed.data.sandboxId} is already ${existing.status}.` }, { status: 409 });
      }
      const record: LocalDispatchRecord = { envelope: parsed.data, status: "pending" };
      await this.putRecord(record);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/claim") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const operator = typeof body.operator === "string" ? body.operator.slice(0, 200) : undefined;
      const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      const pending = [...records.values()]
        .filter((record) => record.status === "pending")
        .sort((a, b) => a.envelope.createdAt - b.envelope.createdAt)[0];
      if (pending === undefined) {
        return Response.json({ envelope: null });
      }
      // Minted here, never accepted from the caller — the token is the
      // proof the settle side holds that this claim won the race.
      const claimToken = crypto.randomUUID();
      await this.putRecord({ ...pending, status: "claimed", claimToken, claimedAt: now, ...(operator !== undefined ? { claimedBy: operator } : {}) });
      return Response.json({ envelope: pending.envelope, claimToken });
    }

    if (request.method === "POST" && url.pathname === "/result") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
      const claimToken = typeof body.claimToken === "string" ? body.claimToken : "";
      const record = await this.getRecord(sandboxId);
      if (record === null) {
        return Response.json({ error: "Run not found." }, { status: 404 });
      }
      if (record.status !== "claimed" || record.claimToken !== claimToken || claimToken === "") {
        return Response.json({ error: `Run ${sandboxId} is not held by this claim.` }, { status: 409 });
      }
      const parsed = localRunResultSchema.safeParse(body.result);
      if (!parsed.success) {
        return Response.json({ error: "Invalid run result." }, { status: 400 });
      }
      await this.putRecord({ ...record, status: "settled", result: parsed.data, settledAt: now });
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const sandboxId = typeof body.sandboxId === "string" ? body.sandboxId : "";
      const record = await this.getRecord(sandboxId);
      if (record === null) return Response.json({ error: "Run not found." }, { status: 404 });
      if (record.status === "settled" || record.status === "cancelled") {
        return Response.json({ ok: true, status: record.status });
      }
      await this.putRecord({ ...record, status: "cancelled", claimToken: undefined, settledAt: now });
      return Response.json({ ok: true, status: "cancelled" as LocalDispatchStatus });
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const sandboxId = url.searchParams.get("sandboxId") ?? "";
      const record = await this.getRecord(sandboxId);
      if (record === null) return Response.json({ error: "Run not found." }, { status: 404 });
      return Response.json({
        status: record.status,
        ...(record.claimedAt !== undefined ? { claimedAt: record.claimedAt, claimedBy: record.claimedBy } : {}),
        ...(record.result !== undefined ? { result: record.result } : {}),
        ...(record.settledAt !== undefined ? { settledAt: record.settledAt } : {}),
      });
    }

    if (request.method === "GET" && url.pathname === "/pending") {
      const records = await this.ctx.storage.list<LocalDispatchRecord>({ prefix: RECORD_PREFIX });
      const pending = [...records.values()]
        .filter((record) => record.status === "pending" || record.status === "claimed")
        .map((record) => ({
          sandboxId: record.envelope.sandboxId,
          status: record.status,
          harness: record.envelope.harness,
          createdAt: record.envelope.createdAt,
          ...(record.claimedAt !== undefined ? { claimedAt: record.claimedAt } : {}),
        }));
      return Response.json({ pending });
    }

    // ── T52 fleet: every verb below is reached only after the Worker route
    // verified the caller (pairing-token HMAC, daemon bearer, or dashboard auth).

    if (request.method === "POST" && url.pathname === "/pairing-nonce") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      if (typeof body.nonce !== "string" || body.nonce === "" || typeof body.expiresAt !== "number") {
        return Response.json({ error: "Invalid pairing nonce." }, { status: 400 });
      }
      await this.ctx.storage.put(`${PAIR_PREFIX}${body.nonce}`, body.expiresAt);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/pair") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      const expiresAt = nonce === "" ? undefined : await this.ctx.storage.get<number>(`${PAIR_PREFIX}${nonce}`);
      if (expiresAt === undefined || now > expiresAt) {
        return Response.json({ error: "Pairing token is expired or already used." }, { status: 401 });
      }
      const pair = decodeOrNull(PairRequestSchema, body.pair);
      if (pair === null) return Response.json({ error: "Invalid pair request." }, { status: 400 });
      await this.ctx.storage.delete(`${PAIR_PREFIX}${nonce}`);
      const machineId = crypto.randomUUID();
      const adapterToken = randomHex(32);
      const record: ComputerRecord = {
        machineId,
        hostname: pair.hostname,
        platform: pair.platform,
        daemonVersion: pair.daemonVersion,
        harnesses: [...pair.harnesses],
        lastHeartbeat: now,
        pairedAt: now,
        tokenHash: await sha256Hex(adapterToken),
      };
      await this.ctx.storage.put(`${COMPUTER_PREFIX}${machineId}`, record);
      return Response.json({ adapterToken, machineId });
    }

    if (request.method === "POST" && url.pathname === "/authorize") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const tokenHash = typeof body.tokenHash === "string" ? body.tokenHash : "";
      // ponytail: linear scan of the fleet per daemon call; add a `token:<hash>` index if fleets grow past dozens.
      const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
      const match = [...computers.values()].find((computer) => tokenHash !== "" && computer.tokenHash === tokenHash);
      if (match === undefined) return Response.json({ error: "Unauthorized." }, { status: 401 });
      return Response.json({ machineId: match.machineId });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      const heartbeat = decodeOrNull(HeartbeatRequestSchema, body);
      if (heartbeat === null) return Response.json({ error: "Invalid heartbeat." }, { status: 400 });
      const existing = await this.ctx.storage.get<ComputerRecord>(`${COMPUTER_PREFIX}${heartbeat.machineId}`);
      const record: ComputerRecord = {
        machineId: heartbeat.machineId,
        hostname: heartbeat.hostname,
        platform: heartbeat.platform,
        daemonVersion: heartbeat.daemonVersion,
        harnesses: [...heartbeat.harnesses],
        lastHeartbeat: now,
        ...(existing?.pairedAt !== undefined ? { pairedAt: existing.pairedAt } : {}),
        ...(heartbeat.activeRunId !== undefined ? { activeRunId: heartbeat.activeRunId } : {}),
        ...(existing?.tokenHash !== undefined ? { tokenHash: existing.tokenHash } : {}),
      };
      await this.ctx.storage.put(`${COMPUTER_PREFIX}${heartbeat.machineId}`, record);
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && url.pathname === "/computers") {
      const computers = await this.ctx.storage.list<ComputerRecord>({ prefix: COMPUTER_PREFIX });
      const list = [...computers.values()]
        .map((computer) => toConnectedComputer(computer, now))
        .sort((a, b) => b.lastHeartbeat - a.lastHeartbeat);
      return Response.json({ computers: list });
    }

    if (request.method === "POST" && url.pathname === "/revoke-computer") {
      const body = await this.json(request);
      if (body instanceof Response) return body;
      if (typeof body.machineId !== "string" || body.machineId === "") {
        return Response.json({ error: "machineId is required." }, { status: 400 });
      }
      // Dropping the record drops the token hash with it: the next /authorize misses → 401.
      await this.ctx.storage.delete(`${COMPUTER_PREFIX}${body.machineId}`);
      return Response.json({ ok: true });
    }

    return Response.json({ error: "Not found." }, { status: 404 });
  }
}

/**
 * The one claim queue per deployment. The binding is optional in Env so a
 * deployment (or test env) without the local runtime never resolves a stub
 * it cannot serve — callers check the flag first, and a missing binding is
 * a hard error, not a silent skip.
 */
export function localDispatchStub(env: { LocalDispatch?: DurableObjectNamespace }): DurableObjectStub {
  if (env.LocalDispatch === undefined) {
    throw new Error("LocalDispatch binding is not configured.");
  }
  return env.LocalDispatch.get(env.LocalDispatch.idFromName(LOCAL_DISPATCH_DO_NAME));
}
