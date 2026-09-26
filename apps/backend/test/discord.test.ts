import { describe, expect, it, vi } from "vitest";
import {
  DISCORD_INTERACTIONS_PATH,
  DISCORD_REPLAY_WINDOW_SECONDS,
  handleDiscordInteractions,
  verifyDiscordRequest,
  type DiscordDeps,
} from "../src/discord.js";
import type { OrchestratorStub } from "../src/chat-lane.js";

const REPO = "https://github.com/owner/repo";
const APPROVAL_ID = "a1b2c3d4-e5f6-47a8-b9c0-d1e2f3a4b5c6";
const APP_ID = "999000111";
const CHANNEL_ID = "777777777777777777";

type KeyPair = CryptoKeyPair;

async function makeKeys(): Promise<{ keyPair: KeyPair; publicKeyHex: string }> {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  const publicKeyHex = Array.from(raw).map((b) => b.toString(16).padStart(2, "0")).join("");
  return { keyPair, publicKeyHex };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(
  keyPair: KeyPair,
  body: string,
  overrides: { timestamp?: string; signature?: string; omitSignature?: boolean } = {},
) {
  const timestamp = overrides.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = overrides.signature ?? toHex(
    new Uint8Array(
      await crypto.subtle.sign(
        { name: "Ed25519" },
        keyPair.privateKey,
        new TextEncoder().encode(timestamp + body),
      ),
    ),
  );
  return new Request(`https://worker.test${DISCORD_INTERACTIONS_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(overrides.omitSignature ? {} : { "X-Signature-Ed25519": signature }),
      "X-Signature-Timestamp": timestamp,
    },
    body,
  });
}

function env(overrides: Record<string, unknown> = {}) {
  return { DISCORD_PUBLIC_KEY: "00".repeat(32), ...overrides } as never;
}

function pingBody() {
  return JSON.stringify({ type: 1 });
}

function commandBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 2,
    application_id: APP_ID,
    token: "tok-abc",
    channel_id: CHANNEL_ID,
    member: { user: { id: "42" } },
    data: {
      name: "shiba",
      options: [
        { name: "repo", value: REPO },
        { name: "task", value: "fix the login bug" },
      ],
    },
    ...overrides,
  });
}

function componentBody(customId: string, userId = "42") {
  return JSON.stringify({
    type: 3,
    application_id: APP_ID,
    token: "tok-abc",
    channel_id: CHANNEL_ID,
    member: { user: { id: userId } },
    data: { custom_id: customId },
    message: { content: "Approval requested" },
  });
}

type SendCall = { method: "PATCH" | "POST"; path: string; body: Record<string, unknown> };

function makeDeps(overrides: Partial<DiscordDeps> = {}) {
  const sends: SendCall[] = [];
  const send = vi.fn(async (method: "PATCH" | "POST", path: string, body: Record<string, unknown>) => {
    sends.push({ method, path, body });
  });
  const runBodies: Record<string, unknown>[] = [];
  const approvalBodies: Record<string, unknown>[] = [];
  const stub: OrchestratorStub = {
    fetch: async (request: Request) => {
      const url = request.url;
      const body = (await request.json()) as Record<string, unknown>;
      if (url.endsWith("/api/runs")) {
        runBodies.push(body);
        return Response.json({ ok: true, approvalId: APPROVAL_ID });
      }
      approvalBodies.push(body);
      return Response.json({ result: (body.approved as boolean) ? "approved" : "rejected" });
    },
  };
  const resolveOrchestrator = vi.fn(async () => stub);
  return {
    sends,
    runBodies,
    approvalBodies,
    resolveOrchestrator,
    deps: { send, resolveOrchestrator, ...overrides } satisfies DiscordDeps,
  };
}

async function responseJson(response: Response | null | undefined) {
  return (await response?.json()) as Record<string, unknown> | undefined;
}

describe("handleDiscordInteractions routing and signature auth", () => {
  it("returns null for a different path so other routes can handle it", async () => {
    const request = new Request("https://worker.test/api/other", { method: "POST", body: "{}" });
    expect(await handleDiscordInteractions(request, env())).toBeNull();
  });

  it("returns null for a GET on the interactions path", async () => {
    const request = new Request(`https://worker.test${DISCORD_INTERACTIONS_PATH}`, { method: "GET" });
    expect(await handleDiscordInteractions(request, env())).toBeNull();
  });

  it("503s when the public key is not configured", async () => {
    const response = await handleDiscordInteractions(
      new Request(`https://worker.test${DISCORD_INTERACTIONS_PATH}`, { method: "POST", body: "{}" }),
      env({ DISCORD_PUBLIC_KEY: "" }),
    );
    expect(response?.status).toBe(503);
    expect(await responseJson(response)).toMatchObject({ error: expect.stringContaining("DISCORD_PUBLIC_KEY") });
  });

  it("401s when the signature headers are absent", async () => {
    const { publicKeyHex } = await makeKeys();
    const request = new Request(`https://worker.test${DISCORD_INTERACTIONS_PATH}`, {
      method: "POST",
      body: pingBody(),
    });
    const response = await handleDiscordInteractions(request, env({ DISCORD_PUBLIC_KEY: publicKeyHex }));
    expect(response?.status).toBe(401);
  });

  it("401s on a signature that does not match the body", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    // Sign timestamp + a different body than the one sent.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = toHex(new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(timestamp + JSON.stringify({ type: 1, forged: true })),
    )));
    const request = await signedRequest(keyPair, pingBody(), { timestamp, signature });
    const response = await handleDiscordInteractions(request, env({ DISCORD_PUBLIC_KEY: publicKeyHex }));
    expect(response?.status).toBe(401);
  });

  it("401s when the timestamp is outside the replay window", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const stale = String(Math.floor(Date.now() / 1000) - DISCORD_REPLAY_WINDOW_SECONDS - 10);
    const request = await signedRequest(keyPair, pingBody(), { timestamp: stale });
    const response = await handleDiscordInteractions(request, env({ DISCORD_PUBLIC_KEY: publicKeyHex }));
    expect(response?.status).toBe(401);
  });

  it("400s when a correctly-signed body is not JSON", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const request = await signedRequest(keyPair, "not json{{");
    const response = await handleDiscordInteractions(request, env({ DISCORD_PUBLIC_KEY: publicKeyHex }));
    expect(response?.status).toBe(400);
  });

  it("answers PING with a pong", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const request = await signedRequest(keyPair, pingBody());
    const response = await handleDiscordInteractions(request, env({ DISCORD_PUBLIC_KEY: publicKeyHex }));
    expect(response?.status).toBe(200);
    expect(await responseJson(response)).toEqual({ type: 1 });
  });
});

describe("verifyDiscordRequest", () => {
  it("accepts a well-formed, fresh, valid signature", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const body = pingBody();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = toHex(new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(timestamp + body),
    )));
    const headers = new Headers({
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    });
    expect(await verifyDiscordRequest(body, headers, publicKeyHex)).toBe(true);
  });

  it("rejects a signature from a different key", async () => {
    const { keyPair } = await makeKeys();
    const other = await makeKeys();
    const body = pingBody();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = toHex(new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(timestamp + body),
    )));
    const headers = new Headers({
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": timestamp,
    });
    expect(await verifyDiscordRequest(body, headers, other.publicKeyHex)).toBe(false);
  });

  it("rejects malformed signature and public key encodings", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers = new Headers({
      "X-Signature-Ed25519": "zz-not-hex",
      "X-Signature-Timestamp": timestamp,
    });
    expect(await verifyDiscordRequest(pingBody(), headers, "aa".repeat(32))).toBe(false);

    const goodSig = toHex(new Uint8Array(64));
    const headers2 = new Headers({
      "X-Signature-Ed25519": goodSig,
      "X-Signature-Timestamp": timestamp,
    });
    expect(await verifyDiscordRequest(pingBody(), headers2, "short")).toBe(false);
  });

  it("rejects a non-numeric timestamp", async () => {
    const headers = new Headers({
      "X-Signature-Ed25519": toHex(new Uint8Array(64)),
      "X-Signature-Timestamp": "yesterday",
    });
    expect(await verifyDiscordRequest(pingBody(), headers, "aa".repeat(32))).toBe(false);
  });

  it("rejects timestamps outside the replay window", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const body = pingBody();
    const now = Date.now();
    const stale = String(Math.floor(now / 1000) - DISCORD_REPLAY_WINDOW_SECONDS - 1);
    const signature = toHex(new Uint8Array(await crypto.subtle.sign(
      { name: "Ed25519" },
      keyPair.privateKey,
      new TextEncoder().encode(stale + body),
    )));
    const headers = new Headers({
      "X-Signature-Ed25519": signature,
      "X-Signature-Timestamp": stale,
    });
    expect(await verifyDiscordRequest(body, headers, publicKeyHex, now)).toBe(false);
  });
});

describe("handleDiscordInteractions /shiba command", () => {
  it("defers, queues a run, and edits the reply into an approval card", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, sends, runBodies, resolveOrchestrator } = makeDeps();
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, commandBody()),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    // Deferred-channel-message-with-source buys time past Discord's 3s window.
    expect(await responseJson(response)).toEqual({ type: 5 });
    expect(resolveOrchestrator).toHaveBeenCalledWith(`discord:${CHANNEL_ID}`);
    expect(runBodies[0]).toMatchObject({
      repoUrl: REPO,
      task: "fix the login bug",
      threadKey: `discord:${CHANNEL_ID}`,
      source: "discord",
      user_id: "42",
    });
    expect(sends).toHaveLength(1);
    const edit = sends[0]!;
    expect(edit.method).toBe("PATCH");
    expect(edit.path).toBe(`/webhooks/${APP_ID}/tok-abc/messages/@original`);
    expect(edit.body.content).toContain(REPO);
    expect(edit.body.content).toContain(APPROVAL_ID);
    expect(edit.body.allowed_mentions).toEqual({ parse: [] });
    const components = edit.body.components as { components: { custom_id: string }[] }[];
    const customIds = components[0]!.components.map((c) => c.custom_id);
    expect(customIds).toEqual([`approve:${APPROVAL_ID}`, `reject:${APPROVAL_ID}`]);
  });

  it("uses DISCORD_CHANNEL_REPOS when the repo option is empty", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, runBodies } = makeDeps();
    const body = commandBody({
      data: { name: "shiba", options: [{ name: "task", value: "fix this" }] },
    });
    await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_CHANNEL_REPOS: JSON.stringify({ [CHANNEL_ID]: REPO }) }),
      undefined,
      deps,
    );
    expect(runBodies[0]?.repoUrl).toBe(REPO);
  });

  it("ephemerally reports the error when the repo cannot be resolved", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, runBodies } = makeDeps();
    const body = commandBody({
      data: { name: "shiba", options: [{ name: "task", value: "fix this" }] },
    });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    expect(runBodies).toHaveLength(0);
    const json = await responseJson(response);
    expect(json?.type).toBe(4);
    const data = json?.data as { content: string; flags: number };
    expect(data.content).toContain("DISCORD_CHANNEL_REPOS");
    expect(data.flags).toBe(64);
  });

  it("ephemerally reports the error when the task is missing", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps } = makeDeps();
    const body = commandBody({
      data: { name: "shiba", options: [{ name: "repo", value: REPO }] },
    });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    const json = await responseJson(response);
    const data = json?.data as { content: string };
    expect(data.content).toContain("Describe the task");
  });

  it("ephemerally rejects an unknown command name", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, runBodies } = makeDeps();
    const body = commandBody({ data: { name: "not-shiba", options: [] } });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    expect(runBodies).toHaveLength(0);
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("Unknown command.");
  });

  it("ephemerally rejects a malformed channel id", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps } = makeDeps();
    const body = commandBody({ channel_id: "not-a-snowflake" });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("Shiba can only be used from a channel.");
  });

  it("ephemerally rejects a missing interaction token", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps } = makeDeps();
    const body = commandBody({ token: "" });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("Malformed interaction.");
  });

  it("patches the deferred reply with the error when queueing fails", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, sends } = makeDeps({
      resolveOrchestrator: async () => ({
        fetch: async () => Response.json({ error: "GITHUB_TOKEN is not set" }, { status: 500 }),
      }),
    });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, commandBody()),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    expect(await responseJson(response)).toEqual({ type: 5 });
    expect(sends).toHaveLength(1);
    expect(String(sends[0]!.body.content)).toContain("Failed to queue the task");
    expect(String(sends[0]!.body.content)).toContain("GITHUB_TOKEN is not set");
  });
});

describe("handleDiscordInteractions approval buttons", () => {
  it("approves a pending run for a listed approver and retires the buttons", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, sends, approvalBodies } = makeDeps();
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, componentBody(`approve:${APPROVAL_ID}`)),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_APPROVERS: "7, 42" }),
      undefined,
      deps,
    );
    // A deferred update acks the press; the card edit follows.
    expect(await responseJson(response)).toEqual({ type: 6 });
    expect(approvalBodies[0]).toEqual({
      threadKey: `discord:${CHANNEL_ID}`,
      approvalId: APPROVAL_ID,
      approved: true,
      decidedBy: "discord:42",
      source: "discord",
    });
    const edit = sends.find((s) => s.method === "PATCH");
    expect(edit?.path).toBe(`/webhooks/${APP_ID}/tok-abc/messages/@original`);
    expect(edit?.body.components).toEqual([]);
    expect(String(edit?.body.content)).toContain("Approved by <@42> — run starting.");
  });

  it("rejects a pending run for a listed approver", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, sends, approvalBodies } = makeDeps();
    await handleDiscordInteractions(
      await signedRequest(keyPair, componentBody(`reject:${APPROVAL_ID}`)),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(approvalBodies[0]).toMatchObject({ approved: false });
    const edit = sends.find((s) => s.method === "PATCH");
    expect(String(edit?.body.content)).toContain("Rejected by <@42> — no run started.");
  });

  it("ephemerally rejects a user who is not on the approver list", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, approvalBodies, sends } = makeDeps();
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, componentBody(`approve:${APPROVAL_ID}`, "99")),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(approvalBodies).toHaveLength(0);
    expect(sends).toHaveLength(0);
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("You are not on the approver list.");
  });

  it("ephemerally rejects everyone when the approver list is empty", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, approvalBodies } = makeDeps();
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, componentBody(`approve:${APPROVAL_ID}`)),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    expect(approvalBodies).toHaveLength(0);
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("You are not on the approver list.");
  });

  it("ephemerally dismisses a custom_id that is not a decision pointer", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, approvalBodies } = makeDeps();
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, componentBody("some-other-button")),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(approvalBodies).toHaveLength(0);
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("This button is not a Shiba approval.");
  });

  it("follows up ephemerally when the pointer is already resolved", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps, sends } = makeDeps({
      resolveOrchestrator: async () => ({
        fetch: async () => Response.json({ result: "unknown" }),
      }),
    });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, componentBody(`approve:${APPROVAL_ID}`)),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex, DISCORD_APPROVERS: "42" }),
      undefined,
      deps,
    );
    expect(await responseJson(response)).toEqual({ type: 6 });
    const followUp = sends.find((s) => s.method === "POST");
    expect(String(followUp?.body.content)).toContain("already resolved or expired");
    expect(followUp?.body.flags).toBe(64);
    expect(sends.some((s) => s.method === "PATCH")).toBe(false);
  });

  it("ephemerally reports an unsupported interaction type", async () => {
    const { keyPair, publicKeyHex } = await makeKeys();
    const { deps } = makeDeps();
    const body = JSON.stringify({
      type: 5,
      application_id: APP_ID,
      token: "tok-abc",
      channel_id: CHANNEL_ID,
      member: { user: { id: "42" } },
    });
    const response = await handleDiscordInteractions(
      await signedRequest(keyPair, body),
      env({ DISCORD_PUBLIC_KEY: publicKeyHex }),
      undefined,
      deps,
    );
    const json = await responseJson(response);
    expect((json?.data as { content: string }).content).toBe("Unsupported interaction.");
  });
});
