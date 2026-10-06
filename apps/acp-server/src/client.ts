/**
 * HTTP client for a Shiba deployment — the three operator surfaces the ACP
 * server drives: /api/runs (queue + status + cancel), /api/approvals
 * (decide a pending approval), /api/spine (cursor-paged event feed).
 *
 * Auth: SHIBA_TOKEN is a better-auth session token — the deployment's own
 * operator credential, minted via `shiba-acp login` or copied from a live
 * dashboard session. It is sent as the session cookie; the deployment
 * treats the caller as the operator principal (full run visibility,
 * approval decisions allowed — agent principals can never decide).
 */
import { queueRunInputSchema, spineEventSchema, type SpineEvent } from "@shiba/shared";

export class ShibaApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
    this.name = "ShibaApiError";
  }
}

export interface ShibaClientOptions {
  baseUrl: string;
  token: string;
  /** Injectable for tests. */
  fetch?: typeof fetch;
}

export interface QueuedApproval {
  ok: true;
  approvalId: string;
  repoUrl: string;
  task: string;
  route?: unknown;
}

export interface SpinePage {
  events: SpineEvent[];
  outbox: unknown[];
  earliestSeq: number;
  latestSeq: number;
  totalEvents: number;
}

export interface RunRecord {
  runId: string;
  status: string;
  task: string;
  summary?: string;
  error?: string;
  pullUrl?: string;
  diff?: string;
  approval?: { approvalId?: string };
  [key: string]: unknown;
}

export class ShibaClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly doFetch: typeof fetch;

  constructor(options: ShibaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.doFetch = options.fetch ?? fetch;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `better-auth.session_token=${this.token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text === "" ? undefined : JSON.parse(text);
    } catch {
      throw new ShibaApiError(res.status, `Non-JSON response from ${path} (${res.status}).`);
    }
    if (!res.ok) {
      const detail =
        typeof json === "object" && json !== null && "error" in json
          ? String((json as { error: unknown }).error)
          : `${path} failed (${res.status})`;
      throw new ShibaApiError(res.status, detail);
    }
    return json as T;
  }

  /** POST /api/runs — mint a pending approval for this task (the gate). */
  queueRun(input: {
    repoUrl: string;
    task: string;
    baseBranch?: string;
    publishPullRequest?: boolean;
    harness?: string;
    codingModel?: string;
    testCommand?: string[];
    commandId?: string;
  }): Promise<QueuedApproval> {
    const parsed = queueRunInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ShibaApiError(0, `queueRun input failed validation: ${parsed.error.message}`);
    }
    return this.call("POST", "/api/runs", parsed.data);
  }

  /** POST /api/approvals — the human decision on a pending card. */
  resolveApproval(input: {
    threadKey: string;
    approvalId: string;
    approved: boolean;
    decidedBy: string;
  }): Promise<{ result: string }> {
    return this.call("POST", "/api/approvals", input);
  }

  /** GET /api/spine?since=N — cursor-paged event feed; since=0 or absent = full window. */
  async fetchSpine(since?: number): Promise<SpinePage> {
    const page = await this.call<{
      events: unknown[];
      outbox: unknown[];
      earliestSeq: number;
      latestSeq: number;
      totalEvents: number;
    }>("GET", since === undefined ? "/api/spine" : `/api/spine?since=${since}`);
    return {
      ...page,
      events: (page.events ?? [])
        .map((e) => spineEventSchema.safeParse(e))
        .filter((r) => r.success)
        .map((r) => r.data),
    };
  }

  /** GET /api/runs — operator sees the full registry. */
  listRuns(limit?: number): Promise<{ runs: RunRecord[] }> {
    return this.call("GET", limit === undefined ? "/api/runs" : `/api/runs?limit=${limit}`);
  }

  /** GET /api/runs/<id>. */
  getRun(runId: string): Promise<RunRecord> {
    return this.call("GET", `/api/runs/${encodeURIComponent(runId)}`);
  }

  /** DELETE /api/runs/<id> — cancel a live run. */
  cancelRun(runId: string): Promise<unknown> {
    return this.call("DELETE", `/api/runs/${encodeURIComponent(runId)}`);
  }

  /** POST /api/auth/sign-in/email — mint the session token (better-auth). */
  async login(email: string, password: string): Promise<string> {
    const res = await this.doFetch(`${this.baseUrl}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || typeof json.token !== "string" || json.token === "") {
      throw new ShibaApiError(res.status, json.message ?? `Sign-in failed (${res.status}).`);
    }
    return json.token;
  }
}
