/**
 * Behavioral coverage for the embedded ACP driver (`ACP_DRIVER_SOURCE`,
 * plain CJS run by `node` inside the sandbox — T4).
 *
 * The source is evaluated in a `node:vm` context against a fake child
 * process and a fully controllable timer queue, so the timeout paths
 * (60s control / 20min prompt) run in real sequence without real clocks:
 * handshake → set_model tolerance → prompt → drain-aware exit.
 */
import { EventEmitter } from "node:events";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import { ACP_DRIVER_SOURCE, AcpErrorEvent, AcpEventError, parseAcpDriverEvent } from "../src/harness/acp.js";

interface Timer {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

interface Frame {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message?: string };
}

interface DriverRun {
  /** JSON-RPC frames the driver wrote to the agent's stdin. */
  frames: Frame[];
  /** NDJSON lines the driver emitted on its own stdout, parsed. */
  events: Record<string, unknown>[];
  /** process.exit calls in order. */
  exits: number[];
  /** child.kill signals in order. */
  kills: string[];
  /** Pending (uncleared) timers — send() timeouts live here. */
  timers: Timer[];
  /** Emit `body` (one NDJSON line) on the agent's stdout. */
  respond(body: Frame): void;
  /** Emit `body` as a raw string (notifications, requests). */
  push(body: string): void;
  /** Fire every pending timer whose delay matches `ms`. */
  fire(ms: number): number;
  /** Set process.stdout.writableLength so exitWhenDrained waits. */
  setWritableLength(n: number): void;
  /** Emit 'drain' on process.stdout. */
  drain(): void;
  /** Emit 'exit' on the fake child process. */
  exit(code: number): void;
}

const CONTROL_TIMEOUT_MS = 60_000;
const PROMPT_TIMEOUT_MS = 20 * 60_000;

const CFG = {
  argv: ["acp-agent", "--stdio"],
  model: "claude-sonnet-4",
  task: "fix the bug",
  label: "TestACP",
};

function loadDriver(cfg: Record<string, unknown> = CFG): DriverRun {
  const frames: Frame[] = [];
  const events: Record<string, unknown>[] = [];
  const exits: number[] = [];
  const kills: string[] = [];
  const timers: Timer[] = [];
  let timerSeq = 0;
  let emitted = "";

  const child = new EventEmitter() as EventEmitter & {
    stdin: { write(s: string): void };
    stdout: EventEmitter;
    kill(signal: string): void;
  };
  child.stdin = { write: (s: string) => frames.push(JSON.parse(s.trim()) as Frame) };
  child.stdout = new EventEmitter();
  child.kill = (signal: string) => kills.push(signal);

  const stdout = new EventEmitter() as EventEmitter & {
    write(s: string): boolean;
    writableLength: number;
  };
  stdout.write = (s: string) => {
    emitted += s;
    let i = emitted.indexOf("\n");
    while (i >= 0) {
      events.push(JSON.parse(emitted.slice(0, i)) as Record<string, unknown>);
      emitted = emitted.slice(i + 1);
      i = emitted.indexOf("\n");
    }
    return true;
  };
  stdout.writableLength = 0;

  const setTimeoutFake = (fn: () => void, ms: number) => {
    const timer: Timer = { id: ++timerSeq, fn, ms, cleared: false };
    timers.push(timer);
    return { timer, unref() {} };
  };
  const clearTimeoutFake = (handle: unknown) => {
    const t = (handle as { timer?: Timer } | undefined)?.timer;
    if (t) t.cleared = true;
  };

  const sandbox = {
    require: (id: string) => {
      if (id === "node:child_process") return { spawn: () => child };
      throw new Error(`unexpected require: ${id}`);
    },
    process: {
      stdout,
      cwd: () => "/workspace/sbx",
      env: {},
      exit: (code: number) => exits.push(code),
    },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
  };
  // The production wrapper embeds cfg the same way (harness/acp.ts):
  // "use strict"; const cfg = <json>; — then the shared driver source.
  vm.runInContext(
    `"use strict"; const cfg = ${JSON.stringify(cfg)};\n${ACP_DRIVER_SOURCE}`,
    vm.createContext(sandbox),
  );

  return {
    frames,
    events,
    exits,
    kills,
    timers,
    respond: (body) => {
      child.stdout.emit("data", `${JSON.stringify(body)}\n`);
    },
    push: (body) => child.stdout.emit("data", `${body}\n`),
    fire: (ms) => {
      let count = 0;
      for (const t of timers) {
        if (!t.cleared && t.ms === ms) {
          t.cleared = true;
          count += 1;
          t.fn();
        }
      }
      return count;
    },
    setWritableLength: (n) => {
      stdout.writableLength = n;
    },
    drain: () => stdout.emit("drain"),
    exit: (code) => child.emit("exit", code),
  };
}

/** Let the driver's queued microtasks run between scripted responses. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Advance the happy path to just before/at the prompt call. */
async function handshake(run: DriverRun) {
  await tick();
  expect(run.frames[0]?.method).toBe("initialize");
  run.respond({ id: 1, result: {} });
  await tick();
  expect(run.frames[1]?.method).toBe("session/new");
  run.respond({ id: 2, result: { sessionId: "s1" } });
  await tick();
}

describe("ACP driver — happy path", () => {
  it("runs initialize → session/new → set_model → prompt, then done + SIGTERM + exit 0", async () => {
    const run = loadDriver();
    await handshake(run);
    expect(run.frames[2]?.method).toBe("session/set_model");
    expect(run.frames[2]?.params).toMatchObject({ sessionId: "s1", modelId: "claude-sonnet-4" });
    run.respond({ id: 3, result: {} });
    await tick();
    expect(run.frames[3]?.method).toBe("session/prompt");
    expect(JSON.stringify(run.frames[3]?.params)).toContain("fix the bug");
    run.respond({ id: 4, result: { stopReason: "end_turn" } });
    await tick();
    await tick();
    expect(run.events.at(-1)).toEqual({ type: "done", text: "stopReason: end_turn" });
    expect(run.kills).toContain("SIGTERM");
    expect(run.exits).toEqual([0]);
  });

  it("re-emits session updates as NDJSON and auto-allows permission requests", async () => {
    const run = loadDriver();
    await handshake(run);
    run.push(JSON.stringify({ method: "session/update", params: { update: {
      sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "hi " }, { text: "there" }],
    } } }));
    run.push(JSON.stringify({ method: "session/update", params: { update: {
      sessionUpdate: "tool_call", title: "read file",
    } } }));
    run.push(JSON.stringify({ id: 41, method: "session/request_permission", params: {
      options: [{ kind: "deny", optionId: "o0" }, { kind: "allow_once", optionId: "o1" }],
    } }));
    run.push(JSON.stringify({ id: 42, method: "fs/read_text_file", params: {} }));
    expect(run.events.map((e) => e.text)).toEqual(["hi there", "tool: read file"]);
    // The allow option is selected; the unimplemented fs request gets -32601.
    expect(run.frames.at(-2)).toMatchObject({
      id: 41,
      result: { outcome: { outcome: "selected", optionId: "o1" } },
    });
    expect(run.frames.at(-1)).toMatchObject({
      id: 42,
      error: { code: -32601, message: "client does not implement fs/read_text_file" },
    });
  });
});

describe("ACP driver — timeouts", () => {
  it("fires the 60s control timeout with the method name in the message", async () => {
    const run = loadDriver();
    await tick();
    expect(run.frames[0]?.method).toBe("initialize");
    expect(run.fire(CONTROL_TIMEOUT_MS)).toBe(1);
    await tick();
    await tick();
    const error = run.events.find((e) => e.type === "error");
    expect(String(error?.message)).toContain("initialize timed out — the agent stopped answering JSON-RPC");
    expect(run.kills).toContain("SIGKILL");
    expect(run.exits[0]).toBe(1);
  });

  it("prompt keeps the 20-minute budget — a 60s lapse does not kill it", async () => {
    const run = loadDriver();
    await handshake(run);
    run.respond({ id: 3, result: {} });
    await tick();
    expect(run.frames[3]?.method).toBe("session/prompt");
    // Only the prompt's long timer is pending; nothing at 60s is armed.
    expect(run.fire(CONTROL_TIMEOUT_MS)).toBe(0);
    expect(run.timers.some((t) => !t.cleared && t.ms === PROMPT_TIMEOUT_MS)).toBe(true);
    expect(run.events).toHaveLength(0);
    expect(run.fire(PROMPT_TIMEOUT_MS)).toBe(1);
    await tick();
    await tick();
    const error = run.events.find((e) => e.type === "error");
    expect(String(error?.message)).toContain("session/prompt timed out");
    expect(run.exits[0]).toBe(1);
  });
});

describe("ACP driver — exit and error propagation", () => {
  it("rejects in-flight calls when the child exits mid-handshake", async () => {
    const run = loadDriver();
    await tick();
    // initialize is in flight; the agent dies instead of answering.
    run.exit(3);
    await tick();
    await tick();
    const messages = run.events.filter((e) => e.type === "error").map((e) => String(e.message));
    expect(messages[0]).toContain("exited before the prompt completed (code 3)");
    expect(messages[1]).toContain("TestACP exited (code 3)");
    expect(run.kills).toContain("SIGKILL");
    expect(run.exits.every((c) => c === 1)).toBe(true);
  });

  it("propagates a JSON-RPC error with code and message", async () => {
    const run = loadDriver();
    await tick();
    run.respond({ id: 1, error: { code: -32600, message: "bad request" } });
    await tick();
    await tick();
    const error = run.events.find((e) => e.type === "error");
    expect(String(error?.message)).toContain("bad request (-32600)");
    expect(run.exits[0]).toBe(1);
  });

  it("tolerates -32601 only on session/set_model — a note, then the default model continues", async () => {
    const run = loadDriver();
    await handshake(run);
    run.respond({ id: 3, error: { code: -32601, message: "method not found" } });
    await tick();
    expect(run.events).toContainEqual({
      type: "note",
      text: "TestACP does not implement session/set_model — running its default model",
    });
    // The run continues to the prompt instead of failing.
    expect(run.frames[3]?.method).toBe("session/prompt");
    run.respond({ id: 4, result: { stopReason: "end_turn" } });
    await tick();
    await tick();
    expect(run.exits).toEqual([0]);
  });

  it("does not tolerate other error codes on session/set_model", async () => {
    const run = loadDriver();
    await handshake(run);
    run.respond({ id: 3, error: { code: -32000, message: "model rejected" } });
    await tick();
    await tick();
    const error = run.events.find((e) => e.type === "error");
    expect(String(error?.message)).toContain("model rejected (-32000)");
    // The prompt is never sent.
    expect(run.frames.map((f) => f.method)).not.toContain("session/prompt");
    expect(run.exits[0]).toBe(1);
  });
});

describe("ACP driver — exitWhenDrained", () => {
  it("holds exit until stdout drains when writes are pending", async () => {
    const run = loadDriver();
    await handshake(run);
    run.respond({ id: 3, result: {} });
    await tick();
    run.setWritableLength(4);
    run.respond({ id: 4, result: { stopReason: "end_turn" } });
    await tick();
    await tick();
    // Exit is deferred: neither process.exit nor the 2s fallback has run.
    expect(run.exits).toHaveLength(0);
    run.drain();
    expect(run.exits).toEqual([0]);
  });

  it("falls back to a 2s timer when the pipe never drains", async () => {
    const run = loadDriver();
    await handshake(run);
    run.respond({ id: 3, result: {} });
    await tick();
    run.setWritableLength(4);
    run.respond({ id: 4, result: { stopReason: "end_turn" } });
    await tick();
    await tick();
    expect(run.exits).toHaveLength(0);
    run.fire(2000);
    expect(run.exits).toEqual([0]);
  });
});

describe("parseAcpDriverEvent", () => {
  it("maps emitted frames to text events and throws typed errors", () => {
    expect(parseAcpDriverEvent('{"type":"agent_message_chunk","text":"hello"}', "TestACP")).toEqual({
      kind: "text",
      text: "hello",
    });
    // The -32601 tolerance note surfaces to the harness as a text line.
    expect(parseAcpDriverEvent('{"type":"note","text":"n"}', "TestACP")).toEqual({
      kind: "text",
      text: "n",
    });
    expect(parseAcpDriverEvent('{"type":"done","text":"stopReason: end_turn"}', "TestACP")).toEqual({
      kind: "text",
      text: "stopReason: end_turn",
    });
    expect(parseAcpDriverEvent('{"type":"plan"}', "TestACP")).toBeNull();
    expect(parseAcpDriverEvent("   ", "TestACP")).toBeNull();
  });

  it("throws AcpErrorEvent on {type:error} with the agent's name", () => {
    try {
      parseAcpDriverEvent('{"type":"error","message":"boom"}', "TestACP");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(AcpErrorEvent);
      expect((e as Error).name).toBe("TestACPErrorEvent");
      expect((e as Error).message).toBe("boom");
    }
  });

  it("throws AcpEventError on unparseable or non-object lines", () => {
    for (const line of ["not json", "null", "[1,2]", "\"x\"", "5"]) {
      try {
        parseAcpDriverEvent(line, "TestACP");
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(AcpEventError);
        expect((e as Error).name).toBe("TestACPEventError");
      }
    }
  });
});
