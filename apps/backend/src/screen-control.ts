/**
 * PLAN-V2-NEXT — computer-use surface, worker/DO side.
 *
 * The sandbox image owns the actual desktop (X server + xdotool/scrot
 * packages land as an image follow-up); this module owns the honest edge:
 * a typed `ScreenAction` becomes strict xdotool argv, exec goes through
 * `scopedExec` with a verb-prefixed allowlist, and every attempt lands on
 * the run's exec signal trail like every other sandbox command.
 *
 * Injection posture: argv entries are built, never interpolated — a
 * `type` text containing `; rm -rf /` arrives in the sandbox as ONE argv
 * element. Everything model-controlled (coords, buttons, key names,
 * repeat counts) is validated into a number/enum before it becomes argv.
 */
import type { RunSignal } from "@shiba/shared";
import { scopedExec, ScopedExecRefusal } from "./exec-allowlist.js";
import { shellJoin } from "./security.js";
import type { ExecResult, SandboxOps } from "./runtime.js";

export const SCREEN_DISPLAY_ENV = ":0";
const SCREEN_TIMEOUT_MS = 15_000;
const MAX_COORD = 100_000;
const MAX_TYPE_CHARS = 4_000;
const MAX_SCROLL_TICKS = 100;
const MAX_KEYS = 16;
const SCREENSHOT_PATH = "/tmp/shiba-screen.png";

/** xdotool mouse buttons. */
const BUTTON_IDS = { left: 1, middle: 2, right: 3 } as const;
type ButtonName = keyof typeof BUTTON_IDS;

export type ScreenAction =
  | { type: "click"; x: number; y: number; button?: ButtonName | 1 | 2 | 3 }
  | { type: "type"; text: string }
  | { type: "scroll"; dx: number; dy: number }
  | { type: "key"; keys: string }
  | { type: "shot" };

/** The scoped allowlist is verb-prefixed — construction below emits only these verbs. */
export const SCREEN_EXEC_ALLOWLIST: readonly (readonly string[])[] = [
  ["xdotool", "mousemove"],
  ["xdotool", "click"],
  ["xdotool", "type"],
  ["xdotool", "key"],
  ["scrot", "-o"],
  ["base64", "-w0"],
];

/** Input failed validation before it could become argv. */
export class ScreenActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenActionError";
  }
}

const coord = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_COORD) {
    throw new ScreenActionError(`${name} must be an integer in [0, ${MAX_COORD}].`);
  }
  return value;
};

/** xdotool key names are a small closed alphabet — anything else refuses. */
const KEY_NAME = /^[A-Za-z0-9_+.\-]+$/;

const buttonId = (button: ButtonName | 1 | 2 | 3 | undefined): number => {
  if (button === undefined) return 1;
  if (typeof button === "number") {
    if (button === 1 || button === 2 || button === 3) return button;
    throw new ScreenActionError("button must be 1 (left), 2 (middle), or 3 (right).");
  }
  return BUTTON_IDS[button];
};

/**
 * `zod`-free structural validation — the caller is the DO, which already
 * holds the parsed body. Returns the argv arrays to exec, in order.
 */
export function screenActionArgv(action: ScreenAction): string[][] {
  switch (action.type) {
    case "click": {
      const x = coord(action.x, "x");
      const y = coord(action.y, "y");
      const b = buttonId(action.button);
      return [
        ["xdotool", "mousemove", String(x), String(y)],
        ["xdotool", "click", String(b)],
      ];
    }
    case "type": {
      if (typeof action.text !== "string" || action.text.length === 0) {
        throw new ScreenActionError("text must be a non-empty string.");
      }
      if (action.text.length > MAX_TYPE_CHARS) {
        throw new ScreenActionError(`text is capped at ${MAX_TYPE_CHARS} characters.`);
      }
      // The text is one argv element — shell metacharacters are literal.
      return [["xdotool", "type", "--delay", "15", action.text]];
    }
    case "scroll": {
      const dx = coord(Math.abs(action.dx), "|dx|");
      const dy = coord(Math.abs(action.dy), "|dy|");
      if (action.dx === 0 && action.dy === 0) {
        throw new ScreenActionError("a scroll needs a nonzero dx or dy.");
      }
      const argv: string[][] = [];
      // xdotool scrolls through button clicks: 4 up, 5 down, 6 left, 7 right.
      const ticks = (v: number) => Math.min(MAX_SCROLL_TICKS, Math.max(1, Math.round(v / 120) || 1));
      if (action.dy !== 0) {
        argv.push(["xdotool", "click", "--repeat", String(ticks(Math.abs(action.dy))), action.dy < 0 ? "4" : "5"]);
      }
      if (action.dx !== 0) {
        argv.push(["xdotool", "click", "--repeat", String(ticks(Math.abs(action.dx))), action.dx < 0 ? "6" : "7"]);
      }
      return argv;
    }
    case "key": {
      if (typeof action.keys !== "string" || !action.keys.trim()) {
        throw new ScreenActionError("keys must be a non-empty string.");
      }
      const keys = action.keys.trim().split(/\s+/);
      if (keys.length > MAX_KEYS) {
        throw new ScreenActionError(`at most ${MAX_KEYS} keys per call.`);
      }
      for (const key of keys) {
        if (!KEY_NAME.test(key)) {
          throw new ScreenActionError(`invalid key name: ${key.slice(0, 40)}`);
        }
      }
      return [["xdotool", "key", ...keys]];
    }
    case "shot":
      return [
        ["scrot", "-o", SCREENSHOT_PATH],
        ["base64", "-w0", SCREENSHOT_PATH],
      ];
    default:
      throw new ScreenActionError("Unknown screen action.");
  }
}

export interface ScreenActionResult {
  ok: boolean;
  /** Present for "shot" actions. */
  screenshotBase64?: string;
  /** Last exec's stderr tail — why a nonzero exit happened. */
  stderr?: string;
}

/**
 * Drive one screen action inside a run's sandbox. Every command goes
 * through scopedExec (verb allowlist + exec.invoked/exec.settled signal
 * receipts); the caller persists the collector onto the run row.
 */
export async function runScreenAction(
  ops: SandboxOps,
  action: ScreenAction,
  signals: RunSignal[],
): Promise<ScreenActionResult> {
  const argvList = screenActionArgv(action);
  let last: ExecResult | undefined;
  for (const argv of argvList) {
    last = await scopedExec(ops, shellJoin(argv), {
      env: { DISPLAY: SCREEN_DISPLAY_ENV },
      timeoutMs: SCREEN_TIMEOUT_MS,
      allowlist: SCREEN_EXEC_ALLOWLIST,
      signals,
      // scrot+base64 can emit ~2MB of base64 — shots get the big cap.
      ...(action.type === "shot" ? { maxOutputChars: 4_000_000 } : {}),
    });
    if (last.exitCode !== 0) {
      return { ok: false, ...(last.stderr ? { stderr: last.stderr.slice(0, 2000) } : {}) };
    }
  }
  if (action.type === "shot") {
    return { ok: true, screenshotBase64: (last?.stdout ?? "").trim() };
  }
  return { ok: true };
}

export { ScopedExecRefusal };
