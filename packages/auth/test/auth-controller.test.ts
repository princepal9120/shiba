/**
 * T47 — shared auth core (PLAN.md §18.9): the state machine the
 * subscription harnesses (T48–T50) hang on. Pins the three ported rules:
 * ownership (one session owns a flow), only the capability probe sets
 * `succeeded`, and ordered idempotent sign-out (admission → in-flight →
 * metadata). Flow state is metadata in AGENT_TOKENS KV — never a credential.
 */
import { describe, expect, it } from "vitest";
import type { AuthSnapshot } from "@shiba/shared";
import {
  AuthFlowError,
  createAuthController,
  type AuthProviderHooks,
} from "../src/controller.js";

class FakeKV {
  readonly map = new Map<string, string>();
  fail = false;
  async get(key: string): Promise<string | null> {
    if (this.fail) throw new Error("KV down");
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: string): Promise<void> {
    if (this.fail) throw new Error("KV down");
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

interface TestEnv { AGENT_TOKENS: KVNamespace; }

function makeEnv() {
  const kv = new FakeKV();
  const env = { AGENT_TOKENS: kv as unknown as KVNamespace };
  return { env, kv };
}

function hooks(overrides: Partial<AuthProviderHooks<TestEnv>> = {}) {
  const calls: string[] = [];
  const h: AuthProviderHooks<TestEnv> = {
    probe: async () => ({ ok: true, expiresAt: 1_700_000_000_000 }),
    ...overrides,
  };
  return { h, calls };
}

const ID = "claude-sub:acct1";

describe("ownership", () => {
  it("a flow belongs to the session that began it; others read but cannot mutate", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks().h);
    await controller.begin("sess-A");
    // Another session can read…
    const snap = await controller.snapshot();
    expect(snap.ownerSessionId).toBe("sess-A");
    expect(snap.phase).toBe("starting");
    // …but cannot advance or cancel.
    await expect(controller.verify("sess-B")).rejects.toBeInstanceOf(AuthFlowError);
    await expect(controller.clear("sess-B")).rejects.toBeInstanceOf(AuthFlowError);
    await expect(controller.begin("sess-B")).rejects.toBeInstanceOf(AuthFlowError);
    // Owner is unaffected.
    await expect(controller.verify("sess-A")).resolves.toMatchObject({ phase: "succeeded" });
  });

  it("an idle flow may be claimed by begin; a second owner's begin is refused mid-flight", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks().h);
    await controller.begin("sess-A");
    await controller.begin("sess-A"); // re-begin by the owner is legal (restart)
    await expect(controller.begin("sess-B")).rejects.toMatchObject({ reason: "not_owner" });
  });
});

describe("probe rule — only verify() sets succeeded", () => {
  it("begin never produces succeeded; probe verdict does", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks().h);
    await controller.begin("sess-A");
    expect((await controller.snapshot()).phase).toBe("starting");
    const snap = await controller.verify("sess-A");
    expect(snap.phase).toBe("succeeded");
    expect(snap.expiresAt).toBe(1_700_000_000_000);
  });

  it("a failed probe lands on failed with the real reason; a throw also fails closed", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks({
      probe: async () => ({ ok: false, message: "invalid token: 401 from probe" }),
    }).h);
    await controller.begin("sess-A");
    const snap = await controller.verify("sess-A");
    expect(snap.phase).toBe("failed");
    expect(snap.message).toContain("401");

    const thrower = createAuthController<TestEnv>(env, "claude-sub:acct2", hooks({
      probe: async () => { throw new Error("sandbox refused"); },
    }).h);
    await thrower.begin("sess-A");
    expect((await thrower.verify("sess-A")).phase).toBe("failed");
  });

  it("verify from idle/cleared refuses instead of probing", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks().h);
    await expect(controller.verify("sess-A")).rejects.toMatchObject({ reason: "invalid_phase" });
  });

  it("waiting: a provider's onBegin may park the flow (T50); verify still gates succeeded", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks({
      onBegin: async () => ({ wait: "paste the Google redirect URL" }),
    }).h);
    await controller.begin("sess-A");
    expect((await controller.snapshot()).phase).toBe("waiting");
    const snap = await controller.verify("sess-A");
    expect(snap.phase).toBe("succeeded");
  });
});

describe("ordered, idempotent sign-out", () => {
  it("clear runs closeAdmission → stopInFlight → metadata wipe, in that order", async () => {
    const { env } = makeEnv();
    const order: string[] = [];
    const controller = createAuthController<TestEnv>(env, ID, {
      probe: async () => ({ ok: true }),
      closeAdmission: async () => { order.push("closeAdmission"); },
      stopInFlight: async () => { order.push("stopInFlight"); },
      onCleared: async () => { order.push("onCleared"); },
    });
    await controller.begin("sess-A");
    await controller.verify("sess-A");
    await controller.clear("sess-A");
    expect(order).toEqual(["closeAdmission", "stopInFlight", "onCleared"]);
    expect((await controller.snapshot()).phase).toBe("cleared");
    // Idempotent + safe twice.
    await controller.clear("sess-A");
    expect((await controller.snapshot()).phase).toBe("cleared");
  });

  it("clear works mid-flight (waiting/verifying states), not just succeeded", async () => {
    const { env } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks({
      onBegin: async () => ({ wait: "…" }),
    }).h);
    await controller.begin("sess-A");
    await controller.clear("sess-A");
    expect((await controller.snapshot()).phase).toBe("cleared");
  });
});

describe("storage", () => {
  it("flow state is metadata in KV under auth_flow_<id>; a KV outage fails closed", async () => {
    const { env, kv } = makeEnv();
    const controller = createAuthController<TestEnv>(env, ID, hooks().h);
    await controller.begin("sess-A");
    const keys = [...kv.map.keys()];
    expect(keys).toEqual([`${"auth_flow_"}${ID}`]);
    const raw = kv.map.get(keys[0]!)!;
    expect(raw).not.toContain("token"); // never a credential field
    kv.fail = true;
    await expect(controller.snapshot()).rejects.toMatchObject({ reason: "store_unavailable" });
  });

  it("type boundary: ProviderAuthController is importable from @shiba/shared", async () => {
    // Compile-time proof the harness-facing type crosses the boundary
    // without importing packages/auth — the interface is the shared export.
    const controller = createAuthController<TestEnv>(makeEnv().env, ID, hooks().h);
    const typed: import("@shiba/shared").ProviderAuthController = controller;
    const snap: AuthSnapshot = await typed.snapshot();
    expect(snap.phase).toBe("idle");
  });
});
