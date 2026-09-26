/**
 * ModelConfig Durable Object — the deployment's connection catalog and
 * purpose policy store (spec/MODEL-CONNECTIONS-ARCHITECTURE.md §5.2).
 *
 * One instance ("default") holds every record. Phase 1 persists metadata
 * only: no secret values ever enter this store — a connection's
 * `credentialRef` names a pre-provisioned AI Gateway BYOK alias or Worker
 * secret, and registration rejects anything that looks like pasted key
 * material.
 *
 * The DO is a plain class (like Automations): the Worker owns auth and
 * CSRF checks before forwarding; the DO trusts only the Worker's
 * internal fetch and validates shapes with its own guards.
 */
import {
  CONNECTION_SERVICES,
  EMPTY_POLICY,
  SERVICE_AUTH_MODE,
  validatePolicyModels,
  type Connection,
  type ConnectionService,
  type ConnectionStatus,
  type PurposePolicy,
} from "./model-connections.js";
import type { Env } from "./env.js";

export const MODEL_CONFIG_DO_NAME = "default";

const STATE_KEY = "state";

export interface ModelConfigState {
  connections: Connection[];
  policy: PurposePolicy;
}

export function modelConfigStub(env: Pick<Env, "ModelConfig">): DurableObjectStub {
  return env.ModelConfig.get(env.ModelConfig.idFromName(MODEL_CONFIG_DO_NAME));
}

/** Registration rejects pasted secrets: a credentialRef names a reference. */
const SECRET_SHAPED = /^(sk-|sk_live_|sk-ant-|ghp_|gho_|ghu_|ghs_|ghr_|github_pat_|xox[baprs]-|AKIA|AIza|glpat-|gsk_|xai-|hf_|ya29\.|eyJ[A-Za-z0-9_-]{10,}\.|[A-Fa-f0-9]{64,})/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export class ModelConfig {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {}

  private async load(): Promise<ModelConfigState> {
    const state = await this.ctx.storage.get<ModelConfigState>(STATE_KEY);
    return state ?? { connections: [], policy: EMPTY_POLICY };
  }

  private async save(state: ModelConfigState): Promise<void> {
    await this.ctx.storage.put(STATE_KEY, state);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    try {
      if (pathname === "/connections" && request.method === "GET") {
        const state = await this.load();
        return Response.json({ connections: state.connections });
      }
      if (pathname === "/connections" && request.method === "POST") {
        return await this.registerConnection(await request.json().catch(() => null));
      }
      const match = /^\/connections\/([^/]+)$/.exec(pathname);
      if (match) {
        const id = decodeURIComponent(match[1] as string);
        if (request.method === "PATCH") return await this.updateConnection(id, await request.json().catch(() => null));
        if (request.method === "DELETE") return await this.disableConnection(id);
        return Response.json({ error: "Method not allowed." }, { status: 405 });
      }
      if (pathname === "/policy" && request.method === "GET") {
        const state = await this.load();
        return Response.json({ policy: state.policy });
      }
      if (pathname === "/policy" && request.method === "PUT") {
        return await this.putPolicy(await request.json().catch(() => null));
      }
      return Response.json({ error: "Not found." }, { status: 404 });
    } catch (error) {
      // A DO fault must not strand the caller on a 500 with no shape.
      console.error(`ModelConfig ${pathname} failed`, error instanceof Error ? error.message : String(error));
      return Response.json({ error: "Model configuration store failed." }, { status: 500 });
    }
  }

  private async registerConnection(body: unknown): Promise<Response> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    if (!isNonEmptyString(input.service) || !(CONNECTION_SERVICES as readonly string[]).includes(input.service)) {
      return Response.json({ error: `service must be one of ${CONNECTION_SERVICES.join(", ")}.` }, { status: 400 });
    }
    const service = input.service as ConnectionService;
    if (!isNonEmptyString(input.displayName) || input.displayName.length > 120) {
      return Response.json({ error: "displayName must be a non-empty string of at most 120 characters." }, { status: 400 });
    }
    const credentialRef = isNonEmptyString(input.credentialRef) ? input.credentialRef.trim() : null;
    if (credentialRef !== null) {
      if (credentialRef.length > 200) {
        return Response.json({ error: "credentialRef must be at most 200 characters." }, { status: 400 });
      }
      if (SECRET_SHAPED.test(credentialRef)) {
        return Response.json(
          { error: "credentialRef names a pre-provisioned alias or secret — never paste key material." },
          { status: 400 },
        );
      }
    }
    const state = await this.load();
    const now = Date.now();
    const connection: Connection = {
      id: `conn_${crypto.randomUUID()}`,
      owner: "deployment",
      service,
      authMode: SERVICE_AUTH_MODE[service],
      status: "unconfigured",
      displayName: input.displayName.trim(),
      credentialRef,
      createdAt: now,
      updatedAt: now,
      lastCheckedAt: null,
    };
    state.connections.push(connection);
    await this.save(state);
    return Response.json({ connection }, { status: 201 });
  }

  private async updateConnection(id: string, body: unknown): Promise<Response> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    const input = body as Record<string, unknown>;
    const state = await this.load();
    const index = state.connections.findIndex((connection) => connection.id === id);
    if (index < 0) {
      return Response.json({ error: "Connection not found." }, { status: 404 });
    }
    const connection = { ...state.connections[index]! };
    if (input.displayName !== undefined) {
      if (!isNonEmptyString(input.displayName) || input.displayName.length > 120) {
        return Response.json({ error: "displayName must be a non-empty string of at most 120 characters." }, { status: 400 });
      }
      connection.displayName = input.displayName.trim();
    }
    if (input.status !== undefined) {
      const allowed: ConnectionStatus[] = ["ready", "invalid", "disabled", "unconfigured"];
      if (!isNonEmptyString(input.status) || !allowed.includes(input.status as ConnectionStatus)) {
        return Response.json({ error: `status must be one of ${allowed.join(", ")}.` }, { status: 400 });
      }
      connection.status = input.status as ConnectionStatus;
    }
    if (input.credentialRef !== undefined) {
      if (input.credentialRef === null) {
        connection.credentialRef = null;
      } else if (isNonEmptyString(input.credentialRef) && input.credentialRef.length <= 200 && !SECRET_SHAPED.test(input.credentialRef.trim())) {
        connection.credentialRef = input.credentialRef.trim();
      } else {
        return Response.json({ error: "credentialRef must name a pre-provisioned alias or secret, never key material." }, { status: 400 });
      }
    }
    if (input.markChecked === true) {
      connection.lastCheckedAt = Date.now();
    }
    connection.updatedAt = Date.now();
    state.connections[index] = connection;
    await this.save(state);
    return Response.json({ connection });
  }

  /** Delete is a soft disable: pending approvals referencing it fail safely. */
  private async disableConnection(id: string): Promise<Response> {
    const state = await this.load();
    const index = state.connections.findIndex((connection) => connection.id === id);
    if (index < 0) {
      return Response.json({ error: "Connection not found." }, { status: 404 });
    }
    state.connections[index] = {
      ...state.connections[index]!,
      status: "disabled",
      updatedAt: Date.now(),
    };
    await this.save(state);
    return Response.json({ connection: state.connections[index] });
  }

  private async putPolicy(body: unknown): Promise<Response> {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    const validated = validatePolicyModels((body as Record<string, unknown>).models);
    if ("error" in validated) {
      return Response.json({ error: validated.error }, { status: 400 });
    }
    const state = await this.load();
    const policy: PurposePolicy = {
      version: state.policy.version + 1,
      models: validated.models,
      updatedAt: Date.now(),
    };
    state.policy = policy;
    await this.save(state);
    return Response.json({ policy });
  }
}
