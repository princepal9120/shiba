/**
 * Behavioral coverage for the interactive surfaces (T3) — the parts of
 * the dashboard whose value lives in timing and filtering, not markup:
 *
 *   - `useApiJson` (via `useSpine`): `inFlight` is true while a fetch is
 *     unsettled and flips false exactly on settle, data or error.
 *   - `ActivityView`: its 5s poll is scheduled only after a fetch
 *     settles — an in-flight request never gets a competing timer.
 *   - `codingModelOptions` / `readyConnectionOptions`: the composer's
 *     model suggestions only offer providers with a ready connection.
 *
 * No DOM is needed: components are invoked as functions against a minimal
 * hooks dispatcher wired through React's internals slot — the same calls
 * the real renderer makes, minus the commit phase. Effects re-run by dep
 * comparison, matching React's own scheduling.
 */
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Minimal hooks dispatcher ────────────────────────────────────────────

interface Effect {
  fn: () => (() => void) | undefined;
  deps: readonly unknown[] | undefined;
}

const INTERNALS = (
  React as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/**
 * Drive a component/hook body against a hand-rolled dispatcher. `flush()`
 * runs the pending effects of the most recent render; a setState inside a
 * flushed effect re-renders (and queues that render's changed effects)
 * like React does on a synchronous update.
 */
function renderHook<T>(fn: () => T) {
  const cells: unknown[] = [];
  const cleanups: ((() => void) | undefined)[] = [];
  let cursor = 0;
  let pendingEffects: { fn: () => void; cell: number }[] = [];
  let value: T;

  function rerender() {
    cursor = 0;
    pendingEffects = [];
    const prev = INTERNALS.H;
    INTERNALS.H = dispatcher;
    try {
      value = fn();
    } finally {
      INTERNALS.H = prev;
    }
  }

  const dispatcher = {
    useState(initial: unknown) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        cells[i] = typeof next === "function" ? (next as (p: unknown) => unknown)(cells[i]) : next;
        rerender();
      };
      return [cells[i], set];
    },
    useEffect(fn: () => (() => void) | undefined, deps?: readonly unknown[]) {
      const i = cursor++;
      const prev = cells[i] as Effect | undefined;
      const changed =
        prev === undefined ||
        deps === undefined ||
        prev.deps === undefined ||
        deps.length !== prev.deps.length ||
        deps.some((d, k) => !Object.is(d, (prev.deps as readonly unknown[])[k]));
      cells[i] = { fn, deps };
      if (changed) {
        const cell = i;
        pendingEffects.push({
          cell,
          fn: () => {
            // React runs the previous instance's cleanup before the new
            // effect — an old poll timer dies before its successor arms.
            const prevCleanup = cleanups[cell];
            if (typeof prevCleanup === "function") {
              prevCleanup();
              cleanups[cell] = undefined;
            }
            const cleanup = fn();
            if (typeof cleanup === "function") cleanups[cell] = cleanup;
          },
        });
      }
    },
    useMemo(fn: () => unknown) {
      return fn();
    },
    useCallback(fn: unknown) {
      // A stable cell: later renders reuse the first closure, matching
      // useCallback's contract well enough for dep comparisons.
      const i = cursor++;
      if (!(i in cells)) cells[i] = fn;
      return cells[i];
    },
    useRef(initial: unknown) {
      const i = cursor++;
      if (!(i in cells)) cells[i] = { current: initial };
      return cells[i];
    },
  };

  rerender();
  return {
    get value() {
      return value as T;
    },
    /** Run the effects pending since the last render. */
    flush() {
      const run = pendingEffects;
      pendingEffects = [];
      for (const effect of run) effect.fn();
      return pendingEffects.length;
    },
  };
}

// ── Fetch / window stubs ────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const jsonResponse = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }) as Response;

const timers: { id: number; fn: () => void; ms: number; cleared: boolean }[] = [];
let timerSeq = 0;

function stubWindow() {
  vi.stubGlobal("window", {
    setTimeout: (fn: () => void, ms: number) => {
      const t = { id: ++timerSeq, fn, ms, cleared: false };
      timers.push(t);
      return t.id;
    },
    clearTimeout: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
  });
}

const pendingTimers = () => timers.filter((t) => !t.cleared);
// Drain the fetch .then → .catch → .finally chain (a few microtask hops).
const flushPromises = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  stubWindow();
});

afterEach(() => {
  vi.unstubAllGlobals();
  timers.length = 0;
});

// ── useApiJson (through the exported useSpine) ──────────────────────────

import { codingModelOptions, readyConnectionOptions, useSpine, type ModelConnectionWire } from "../../frontend/src/live-status";
import { ActivityView } from "../../frontend/src/components/ActivityView";

describe("useApiJson inFlight (via useSpine)", () => {
  it("is true while the fetch is unsettled and flips false on data", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", fetchMock);

    const hook = renderHook(() => useSpine("s-1", true));
    expect(hook.value.inFlight).toBe(true);
    hook.flush();
    expect(fetchMock).toHaveBeenCalledWith("/api/spine?session=s-1");
    // Fetch is still unsettled — inFlight holds.
    expect(hook.value.inFlight).toBe(true);
    gate.resolve(jsonResponse({ events: [], outbox: [] }));
    await flushPromises();
    expect(hook.value.state).toEqual({ kind: "data", data: { events: [], outbox: [] } });
    expect(hook.value.inFlight).toBe(false);
  });

  it("settles to an error state and still releases inFlight", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => gate.promise));
    const hook = renderHook(() => useSpine("s-1", false));
    hook.flush();
    gate.resolve(jsonResponse({ error: "nope" }, 500));
    await flushPromises();
    expect(hook.value.state.kind).toBe("error");
    expect(hook.value.inFlight).toBe(false);
  });

  it("reload() re-enters flight and re-fetches", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    vi.stubGlobal("fetch", fetchMock);
    const hook = renderHook(() => useSpine("s-1", true));
    hook.flush();
    first.resolve(jsonResponse({ events: [{ seq: 1 }], outbox: [] }));
    await flushPromises();
    expect(hook.value.inFlight).toBe(false);
    hook.value.reload();
    // inFlight rises when the re-run effect actually fires, like React's
    // post-commit effect pass — not at the reload() call itself.
    hook.flush();
    expect(hook.value.inFlight).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    second.resolve(jsonResponse({ events: [{ seq: 2 }], outbox: [] }));
    await flushPromises();
    expect(hook.value.inFlight).toBe(false);
  });
});

// ── ActivityView settle-gated polling ───────────────────────────────────

describe("ActivityView settle-gated poll", () => {
  it("never schedules the 5s poll while a fetch is in flight, then polls after settle", async () => {
    const gate = deferred<Response>();
    const fetchMock = vi.fn(() => gate.promise);
    vi.stubGlobal("fetch", fetchMock);

    const view = renderHook(() =>
      ActivityView({ sessionId: "s-1", sessionApiAvailable: true }),
    );
    // First flush: the fetch starts; the poll effect sees inFlight=true and
    // declines to schedule.
    view.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingTimers().filter((t) => t.ms === 5_000)).toHaveLength(0);
    gate.resolve(jsonResponse({ events: [], outbox: [] }));
    await flushPromises();
    // Settled renders re-evaluated the poll effect — now inFlight=false.
    view.flush();
    const polls = pendingTimers().filter((t) => t.ms === 5_000);
    expect(polls).toHaveLength(1);
    // Firing the poll reloads — a second fetch is issued.
    const second = deferred<Response>();
    fetchMock.mockReturnValueOnce(second.promise);
    expect(polls).toHaveLength(1);
    polls[0]?.fn();
    view.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // And while the second fetch is in flight, no competing timer exists.
    second.resolve(jsonResponse({ events: [], outbox: [] }));
    await flushPromises();
    view.flush();
    expect(pendingTimers().filter((t) => t.ms === 5_000)).toHaveLength(1);
  });

  it("a slow fetch keeps the feed unpinned — the poll only appears on settle", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => gate.promise));
    const view = renderHook(() =>
      ActivityView({ sessionId: "default", sessionApiAvailable: false }),
    );
    view.flush();
    // Any number of renders before settle: still no 5s timer.
    view.flush();
    expect(pendingTimers()).toHaveLength(0);
    gate.resolve(jsonResponse({ events: [], outbox: [] }));
    await flushPromises();
    view.flush();
    expect(pendingTimers().map((t) => t.ms)).toEqual([5_000]);
  });
});

// ── Model suggestion filtering ──────────────────────────────────────────

const wireConn = (over: Partial<ModelConnectionWire>): ModelConnectionWire => ({
  id: "conn_x",
  service: "anthropic",
  displayName: "key",
  status: "ready",
  credentialRef: null,
  ...over,
});

describe("readyConnectionOptions + codingModelOptions", () => {
  it("only ready connections feed the provider allowlist", () => {
    const options = readyConnectionOptions([
      wireConn({ id: "conn_ready", status: "ready" }),
      wireConn({ id: "conn_unconf", status: "unconfigured" }),
      wireConn({ id: "conn_invalid", status: "invalid" }),
      wireConn({ id: "conn_disabled", status: "disabled" }),
    ]);
    expect(options.map((o) => o.id)).toEqual(["conn_ready"]);
    expect(options[0]).toMatchObject({ label: "key · anthropic", service: "anthropic" });
  });

  it("filters model ids to providers with a ready connection", () => {
    const connections = readyConnectionOptions([
      wireConn({ id: "conn_anth", service: "anthropic", status: "ready" }),
      wireConn({ id: "conn_openai", service: "openai", status: "disabled" }),
    ]);
    const models = ["anthropic/claude-sonnet-4", "openai/gpt-5", "google/gemini-3"];
    expect(codingModelOptions(models, connections, "none")).toEqual(["anthropic/claude-sonnet-4"]);
    // A selected connection narrows the allowlist to just its service.
    const multi = readyConnectionOptions([
      wireConn({ id: "conn_anth", service: "anthropic", status: "ready" }),
      wireConn({ id: "conn_goo", service: "google", status: "ready" }),
    ]);
    expect(codingModelOptions(models, multi, "conn_goo")).toEqual(["google/gemini-3"]);
    expect(codingModelOptions(models, multi, "none")).toEqual([
      "anthropic/claude-sonnet-4",
      "google/gemini-3",
    ]);
    // Zero ready connections → unfiltered catalog (still informative).
    expect(codingModelOptions(models, [], "none")).toEqual(models);
  });
});
