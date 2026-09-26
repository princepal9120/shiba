/**
 * Route freeze/revalidate is the approval-gate seam: an admissible route is
 * minted at queue time, and a connection revoked between approve and
 * dispatch must fail the run — never substitute another model.
 */
import { describe, expect, it } from "vitest";
import {
  EMPTY_POLICY,
  type ApprovedRoute,
  type Connection,
} from "../src/model-connections.js";
import {
  resolveCodingRoute,
  revalidateCodingRoute,
  type ModelConfigSnapshot,
} from "../src/model-policy.js";

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: "conn_anthropic",
    owner: "deployment",
    service: "anthropic",
    authMode: "gateway-byok",
    status: "ready",
    displayName: "Anthropic BYOK",
    credentialRef: "anthropic-byok",
    createdAt: 0,
    updatedAt: 0,
    lastCheckedAt: null,
    ...overrides,
  };
}

function snapshot(connections: Connection[] = []): ModelConfigSnapshot {
  return { connections, policy: EMPTY_POLICY };
}

describe("resolveCodingRoute", () => {
  it("uses the implicit deployment default when no connection is requested", () => {
    const route = resolveCodingRoute(snapshot(), {
      model: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
    });
    expect(route).toEqual({
      purpose: "coding",
      connectionId: null,
      modelId: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
      policyVersion: 0,
    });
  });

  it("resolves a named connection to its id", () => {
    const route = resolveCodingRoute(snapshot([connection()]), {
      connectionId: "conn_anthropic",
      model: "anthropic/claude-sonnet-4-6",
      harness: "claude-code",
    });
    expect(route.connectionId).toBe("conn_anthropic");
  });

  it("throws on an unknown connection id", () => {
    expect(() =>
      resolveCodingRoute(snapshot(), {
        connectionId: "conn_missing",
        model: "anthropic/claude-sonnet-4-6",
        harness: "claude-code",
      }),
    ).toThrow(/Unknown model connection/);
  });

  it("throws on a disabled connection", () => {
    expect(() =>
      resolveCodingRoute(snapshot([connection({ status: "disabled" })]), {
        connectionId: "conn_anthropic",
        model: "anthropic/claude-sonnet-4-6",
        harness: "claude-code",
      }),
    ).toThrow(/disabled/);
  });

  it("throws when the model is outside the connection's namespace", () => {
    expect(() =>
      resolveCodingRoute(snapshot([connection()]), {
        connectionId: "conn_anthropic",
        model: "openai/gpt-5",
        harness: "codex",
      }),
    ).toThrow(/does not belong to the anthropic connection/);
  });

  it("throws when the harness cannot run the provider", () => {
    expect(() =>
      resolveCodingRoute(snapshot([connection()]), {
        connectionId: "conn_anthropic",
        model: "anthropic/claude-sonnet-4-6",
        harness: "codex",
      }),
    ).toThrow(/codex harness cannot run anthropic models/);
  });
});

describe("revalidateCodingRoute", () => {
  const frozen: ApprovedRoute = {
    purpose: "coding",
    connectionId: "conn_anthropic",
    modelId: "anthropic/claude-sonnet-4-6",
    harness: "claude-code",
    policyVersion: 0,
  };

  it("passes a null-connection (implicit) route unconditionally", () => {
    expect(revalidateCodingRoute(snapshot(), { ...frozen, connectionId: null })).toBeNull();
  });

  it("passes a still-admissible route", () => {
    expect(revalidateCodingRoute(snapshot([connection()]), frozen)).toBeNull();
  });

  it("fails when the approved connection was deleted", () => {
    expect(revalidateCodingRoute(snapshot(), frozen)).toMatch(/no longer exists/);
  });

  it("fails when the approved connection was disabled after approval", () => {
    expect(
      revalidateCodingRoute(snapshot([connection({ status: "disabled" })]), frozen),
    ).toMatch(/disabled/);
  });
});
