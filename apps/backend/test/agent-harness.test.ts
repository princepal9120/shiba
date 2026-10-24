/**
 * Session layer against fake CLIs that speak the Codex app-server and
 * Claude stream-json protocols, plus the sandbox/local wiring around it.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { LocalRunResult } from "@shiba/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSessionManager,
  readEventLog,
  runSessionJob,
} from "../../../scripts/agent-harness.mjs";
import { AGENT_HARNESS_SOURCE } from "../src/harness/agent-harness-source.js";
import { claudeCodeHarness } from "../src/harness/claude-code.js";
import { parseCodexEvent } from "../src/harness/codex.js";
import { resolveHarness } from "../src/harness/index.js";
import { DUMMY_PROVIDER_KEY } from "../src/provider-gateway.js";
import {
  type LocalDispatchClient,
  LocalRuntimeAdapter,
  SandboxRuntimeAdapter,
} from "../src/runtime.js";

const CODEX_FAKE = `
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.env.FAKE_MODE || "happy";
const logPath = process.env.FAKE_LOG || "";
const note = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\\n"); };
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const rl = createInterface({ input: process.stdin });
const turnId = "turn_1";
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  note({ method: msg.method, id: msg.id, result: msg.result, error: msg.error });
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (msg.method === "initialized") return;
  if (msg.method === "thread/start" || msg.method === "thread/resume") {
    send({ jsonrpc: "2.0", id: msg.id, result: { thread: { id: msg.params?.threadId || "thr_1" } } });
    return;
  }
  if (msg.method === "turn/start") {
    send({ jsonrpc: "2.0", id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
    send({ method: "item/agentMessage/delta", params: { delta: "hello", itemId: "m1", threadId: "thr_1", turnId } });
    if (mode === "approve") {
      send({ jsonrpc: "2.0", id: "srv-1", method: "item/commandExecution/requestApproval", params: { command: "ls", reason: "list the tree", itemId: "item-1", threadId: "thr_1", turnId } });
      return;
    }
    if (mode === "interrupt") return;
    if (mode === "refresh") {
      send({ jsonrpc: "2.0", id: "refresh-1", method: "account/chatgptAuthTokens/refresh", params: {} });
      return;
    }
    if (mode === "write") writeFileSync(join(process.cwd(), "new.txt"), "from codex\\n");
    send({ method: "turn/diff/updated", params: { diff: "diff --git a/new.txt b/new.txt\\n+from codex\\n" } });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
    return;
  }
  if (msg.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "interrupted" } } });
    return;
  }
  if (msg.id === "srv-1") {
    if (msg.result?.decision === "accept") writeFileSync(join(process.cwd(), "new.txt"), "approved\\n");
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
    return;
  }
  if (msg.id === "refresh-1") {
    send({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } });
  }
});
`;

const CLAUDE_FAKE = `
import { createInterface } from "node:readline";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const mode = process.env.FAKE_MODE || "happy";
const logPath = process.env.FAKE_LOG || "";
const note = (entry) => { if (logPath) appendFileSync(logPath, JSON.stringify(entry) + "\\n"); };
note({ argv: process.argv });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
const rl = createInterface({ input: process.stdin });
let init = false;
let step = 0;
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  note(msg);
  if (!init) {
    init = true;
    send({ type: "system", subtype: "init", session_id: "sess_1" });
  }
  if (msg.type === "user") {
    send({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
    if (mode === "tool" || mode === "plan") {
      send({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: mode === "plan" ? "Read" : "Write", input: { command: "write greeting" } } });
      return;
    }
    if (mode === "interrupt") return;
    send({ type: "result", result: "done", session_id: "sess_1" });
    return;
  }
  if (msg.type === "control_response") {
    const behavior = msg.response?.response?.behavior;
    step += 1;
    if (mode === "plan" && step === 1) {
      send({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Write", input: { command: "edit" } } });
      return;
    }
    if (behavior === "allow") writeFileSync(join(process.cwd(), "greeting.txt"), "hello\\n");
    send({ type: "result", result: behavior === "allow" ? "wrote" : "denied", session_id: "sess_1" });
    return;
  }
  if (msg.type === "control_request" && msg.request?.subtype === "interrupt") {
    send({ type: "result", result: "stopped", session_id: "sess_1" });
  }
});
`;

const dirs: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "shiba-harness-"));
  dirs.push(dir);
  return dir;
}

function childEnv(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...extra,
  };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("codex app-server adapter", () => {
  async function codexJob(dir: string, mode: string, extra: Record<string, unknown> = {}) {
    const script = path.join(dir, "fake-codex.mjs");
    const log = path.join(dir, "seen.jsonl");
    await writeFile(script, CODEX_FAKE);
    return runSessionJob({
      provider: "codex",
      model: "gpt-test",
      cwd: dir,
      logDir: dir,
      prompt: "say hello",
      permissionMode: "approval-required",
      bin: process.execPath,
      binArgs: [script],
      checkpoints: false,
      emitStdout: false,
      env: childEnv({ FAKE_MODE: mode, FAKE_LOG: log }),
      ...extra,
    });
  }

  it("streams a message and completes a turn", async () => {
    const dir = await scratch();
    const result = await codexJob(dir, "happy");
    expect(result.status).toBe("completed");
    expect(result.exitCode).toBe(0);
    expect(result.threadId).toBe("thr_1");
    expect(
      result.events.some((event) => event.type === "message.delta" && event.text === "hello"),
    ).toBe(true);
    const log = await readEventLog(result.logPath);
    const seqs = log.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(log.some((row) => row.event.type === "turn.completed")).toBe(true);
  });

  it("allows and denies a command approval", async () => {
    const allowDir = await scratch();
    const allow = await codexJob(allowDir, "approve", { onApproval: async () => "allow" });
    expect(allow.status).toBe("completed");
    expect(await readFile(path.join(allowDir, "new.txt"), "utf8")).toBe("approved\n");
    const allowLog = await readFile(path.join(allowDir, "seen.jsonl"), "utf8");
    expect(allowLog).toContain('"decision":"accept"');

    const denyDir = await scratch();
    const deny = await codexJob(denyDir, "approve", { onApproval: async () => "deny" });
    expect(deny.status).toBe("completed");
    await expect(readFile(path.join(denyDir, "new.txt"), "utf8")).rejects.toThrow();
    const denyLog = await readFile(path.join(denyDir, "seen.jsonl"), "utf8");
    expect(denyLog).toContain('"decision":"decline"');
  });

  it("interrupts the in-flight turn", async () => {
    const dir = await scratch();
    let armed = false;
    const result = await codexJob(dir, "interrupt", {
      controlIntervalMs: 15,
      onEvent(event: { type: string }) {
        if (event.type === "turn.started") armed = true;
      },
      control: async () => ({ interrupt: armed }),
    });
    expect(result.status).toBe("interrupted");
    const log = await readFile(path.join(dir, "seen.jsonl"), "utf8");
    expect(log).toContain("turn/interrupt");
  });

  it("resumes a thread instead of starting one", async () => {
    const dir = await scratch();
    const result = await codexJob(dir, "happy", { resumeThreadId: "thr_existing" });
    expect(result.threadId).toBe("thr_existing");
    const log = await readFile(path.join(dir, "seen.jsonl"), "utf8");
    expect(log).toContain("thread/resume");
    expect(log).not.toContain("thread/start");
  });

  it("refuses a ChatGPT token refresh without inventing a token", async () => {
    const dir = await scratch();
    const result = await codexJob(dir, "refresh");
    expect(result.status).toBe("completed");
    const log = await readFile(path.join(dir, "seen.jsonl"), "utf8");
    expect(log).toContain("refresh stays outside the sandbox");
    expect(log).not.toContain("sk-live");
    expect(JSON.stringify(result)).not.toContain("sk-live");
  });

  it("diffs a checkpoint after the turn writes a file", async () => {
    const dir = await scratch();
    await git(dir, ["init", "-b", "main"]);
    await git(dir, ["config", "user.email", "t@example.com"]);
    await git(dir, ["config", "user.name", "test"]);
    await writeFile(path.join(dir, "README"), "base\n");
    await git(dir, ["add", "README"]);
    await git(dir, ["commit", "-m", "base"]);
    const result = await codexJob(dir, "write", { checkpoints: true });
    expect(result.status).toBe("completed");
    expect(result.diff).toContain("new.txt");
    expect(result.diff).toContain("from codex");
  });
});

describe("claude stream-json adapter", () => {
  async function claudeJob(dir: string, mode: string, extra: Record<string, unknown> = {}) {
    const script = path.join(dir, "fake-claude.mjs");
    const log = path.join(dir, "seen.jsonl");
    await writeFile(script, CLAUDE_FAKE);
    return runSessionJob({
      provider: "claude",
      model: "claude-test",
      cwd: dir,
      logDir: dir,
      prompt: "add a greeting",
      permissionMode: "approval-required",
      bin: process.execPath,
      binArgs: [script],
      checkpoints: false,
      emitStdout: false,
      env: childEnv({ FAKE_MODE: mode, FAKE_LOG: log }),
      ...extra,
    });
  }

  it("allows a can_use_tool request", async () => {
    const dir = await scratch();
    const result = await claudeJob(dir, "tool", { onApproval: async () => "allow" });
    expect(result.status).toBe("completed");
    expect(result.summary).toContain("wrote");
    expect(await readFile(path.join(dir, "greeting.txt"), "utf8")).toBe("hello\n");
  });

  it("resumes with --resume", async () => {
    const dir = await scratch();
    await claudeJob(dir, "happy", { resumeThreadId: "sess_9" });
    const log = await readFile(path.join(dir, "seen.jsonl"), "utf8");
    expect(log).toContain("--resume");
    expect(log).toContain("sess_9");
  });

  it("interrupts through a control request", async () => {
    const dir = await scratch();
    let armed = false;
    const result = await claudeJob(dir, "interrupt", {
      controlIntervalMs: 15,
      onEvent(event: { type: string }) {
        if (event.type === "turn.started") armed = true;
      },
      control: async () => ({ interrupt: armed }),
    });
    expect(result.status).toBe("interrupted");
    const log = await readFile(path.join(dir, "seen.jsonl"), "utf8");
    expect(log).toContain("interrupt");
  });

  it("plan mode allows Read and denies Write without asking", async () => {
    const dir = await scratch();
    let asked = false;
    const result = await claudeJob(dir, "plan", {
      permissionMode: "plan",
      onApproval: async () => {
        asked = true;
        return "allow";
      },
    });
    expect(asked).toBe(false);
    expect(result.status).toBe("completed");
    const log = await readFile(path.join(dir, "seen.jsonl"), "utf8");
    expect(log).toContain('"behavior":"allow"');
    expect(log).toContain('"behavior":"deny"');
    await expect(readFile(path.join(dir, "greeting.txt"), "utf8")).rejects.toThrow();
  });
});

describe("concurrent sessions", () => {
  it("runs two codex threads at once", async () => {
    const root = await scratch();
    const script = path.join(root, "fake-codex.mjs");
    await writeFile(script, CODEX_FAKE);
    const manager = createSessionManager();
    const open = (id: string) =>
      manager.open({
        id,
        provider: "codex",
        model: "gpt-test",
        cwd: root,
        logDir: root,
        permissionMode: "accept-edits",
        bin: process.execPath,
        binArgs: [script],
        env: childEnv({ FAKE_MODE: "happy", FAKE_LOG: path.join(root, `${id}.jsonl`) }),
      });
    const [a, b] = await Promise.all([open("sess-a"), open("sess-b")]);
    const [left, right] = await Promise.all([a.turn("one"), b.turn("two")]);
    expect(left.status).toBe("completed");
    expect(right.status).toBe("completed");
    expect(manager.list().sort()).toEqual(["sess-a", "sess-b"]);
    await manager.closeAll();
  });
});

describe("session stdout", () => {
  it("maps a shiba.event line onto the codex progress feed", () => {
    const event = parseCodexEvent(
      JSON.stringify({
        type: "shiba.event",
        text: "hello",
        event: { type: "message.completed", text: "hello" },
      }),
    );
    expect(event).toEqual({ kind: "text", text: "hello" });
  });
});

describe("sandbox and local wiring", () => {
  it("embeds the same script the daemon imports", async () => {
    const source = await readFile(
      new URL("../../../scripts/agent-harness.mjs", import.meta.url),
      "utf8",
    );
    expect(AGENT_HARNESS_SOURCE).toBe(source);
  });

  it("runs the cloud job through node and keeps secrets out of the job file", async () => {
    const files = new Map<string, string>();
    const commands: string[] = [];
    const adapter = new SandboxRuntimeAdapter(claudeCodeHarness);
    const result = await adapter.runCodingTask(
      {
        async gitCheckout() {},
        async writeFile(filePath, content) {
          files.set(filePath, content);
        },
        async exec(command) {
          commands.push(command);
          if (command.includes("status"))
            return { stdout: " M src/a.ts\n", stderr: "", exitCode: 0 };
          if (command.includes("diff"))
            return { stdout: "diff --git a/src/a.ts", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        async readFile() {
          return { kind: "utf8", content: "file" };
        },
      },
      {
        repoUrl: "https://github.com/acme/widgets",
        task: "Add a greeting",
        baseBranch: "main",
        publishPullRequest: false,
        sandboxId: "sb-harness",
        codingModel: "anthropic/claude-sonnet-4-6",
      },
      async () => {},
    );
    expect(result.status).toBe("completed");
    const script = "/workspace/sb-harness.agent-harness.mjs";
    expect(files.get(script)).toBe(AGENT_HARNESS_SOURCE);
    const job = files.get("/workspace/sb-harness.job.json") ?? "";
    expect(job).toContain('"permissionMode":"accept-edits"');
    expect(job).toContain('"/tmp/shiba-sessions"');
    expect(job).toContain("claude-sonnet-4-6");
    expect(job).not.toContain(DUMMY_PROVIDER_KEY);
    expect(job).not.toContain("sk-");
    expect(
      commands.some((command) => command.includes(script) && command.startsWith("'node'")),
    ).toBe(true);
  });

  it("puts an approval-required session on the local envelope and streams events", async () => {
    const result: LocalRunResult = {
      status: "completed",
      exitCode: 0,
      summary: "done",
      stderrTail: "",
      changedFiles: ["a.ts"],
      diff: "diff --git a/a.ts\n",
      files: [{ path: "a.ts", content: "x", encoding: "utf8" }],
      signals: [{ kind: "exec.settled", at: 1, detail: '{"command":"npm test","exit":0}' }],
    };
    const dispatched: { session?: { provider: string; permissionMode: string; model: string } }[] =
      [];
    const messages: string[] = [];
    let index = 0;
    const statuses = [
      {
        status: "claimed" as const,
        claimedBy: "op",
        claimedAt: 1,
        sessionEvents: [{ seq: 1, at: 1, type: "message.completed", text: "hello from harness" }],
      },
      { status: "settled" as const, result },
    ];
    const client: LocalDispatchClient = {
      async dispatch(envelope) {
        dispatched.push(envelope);
      },
      async status() {
        return statuses[Math.min(index++, statuses.length - 1)] as Awaited<
          ReturnType<LocalDispatchClient["status"]>
        >;
      },
      async cancel() {},
    };
    const input = {
      repoUrl: "https://github.com/acme/widgets",
      task: "Add a greeting",
      baseBranch: "main",
      publishPullRequest: false,
      sandboxId: "sb-local",
      codingModel: "anthropic/claude-sonnet-4-6",
    };
    const adapter = new LocalRuntimeAdapter(resolveHarness("claude-code"), {
      client,
      pollIntervalMs: 0,
    });
    const settled = await adapter.runCodingTask({} as never, input, async (event) => {
      if (event.phase === "code") messages.push(event.message);
    });
    expect(settled.status).toBe("completed");
    expect(dispatched[0]?.session).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      permissionMode: "approval-required",
    });
    expect(messages).toContain("hello from harness");

    const plain: { session?: unknown }[] = [];
    const opencode: LocalDispatchClient = {
      async dispatch(envelope) {
        plain.push(envelope);
      },
      async status() {
        return { status: "settled", result };
      },
      async cancel() {},
    };
    await new LocalRuntimeAdapter(resolveHarness("opencode"), {
      client: opencode,
      pollIntervalMs: 0,
    }).runCodingTask(
      {} as never,
      { ...input, codingModel: "google/gemini-3.5-flash-lite" },
      async () => {},
    );
    expect(plain[0]?.session).toBeUndefined();
  });
});
