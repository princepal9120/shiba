/**
 * Newline-delimited JSON-RPC 2.0 peer — the same framing every ACP adapter
 * speaks: one UTF-8 JSON object per line on stdio, requests carry `id`,
 * responses echo it, notifications are method-only.
 */
export type JsonRpcInbound =
  | { kind: "request"; id: string | number; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "response"; id: string | number; result?: unknown; error?: { code: number; message: string } };

export function parseJsonRpc(line: string): JsonRpcInbound | null {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as Record<string, unknown>;
  if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
    return {
      kind: "response",
      id: m.id as string | number,
      result: m.result,
      error: m.error as { code: number; message: string } | undefined,
    };
  }
  if (m.id !== undefined && typeof m.method === "string") {
    return { kind: "request", id: m.id as string | number, method: m.method, params: m.params };
  }
  if (typeof m.method === "string") {
    return { kind: "notification", method: m.method, params: m.params };
  }
  return null;
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<string | number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  /** Bumped whenever the peer emits a request — responses are keyed, never positional. */

  constructor(private readonly write: (msg: Record<string, unknown>) => void) {}

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.write(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
    });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ jsonrpc: "2.0", id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ jsonrpc: "2.0", id, error: { code, message } });
  }

  /** Route a parsed inbound frame; returns true when it was a response. */
  handleResponse(msg: JsonRpcInbound): boolean {
    if (msg.kind !== "response") return false;
    const p = this.pending.get(msg.id);
    if (p === undefined) return true;
    this.pending.delete(msg.id);
    if (msg.error !== undefined) {
      p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
    } else {
      p.resolve(msg.result);
    }
    return true;
  }

  rejectAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
