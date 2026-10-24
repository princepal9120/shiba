/**
 * T68: per-run env values sealed under MODEL_CREDENTIAL_KEY. The digest is a
 * keyed HMAC, so a stored record can't confirm a guessed value offline; the
 * AAD binds a blob to its owning orchestrator and that digest.
 */
import { parseRunEnv, type RunEnvVar } from "@shiba/shared";
import type { Env } from "./env.js";
import type { CodingTaskResult } from "./opencode-input.js";
import { decryptAuthJson, encryptAuthJson, modelCredentialKeyConfigured } from "./subscription-credentials.js";

export interface SealedRunEnv {
  sealed: string;
  names: string[];
  digest: string;
}

// Domain-separates these blobs from subscription credentials sharing the key.
const SCOPE = "run-env";
const DIGEST_INFO = new TextEncoder().encode("shiba-run-env-digest-v1");
// ponytail: shorter values aren't scrubbed — too likely to collide with ordinary text. Raise if users hit it.
const MIN_SCRUB_CHARS = 8;

function requireKey(env: Pick<Env, "MODEL_CREDENTIAL_KEY">): string {
  if (!modelCredentialKeyConfigured(env)) {
    throw new Error("Per-run environment variables need the MODEL_CREDENTIAL_KEY secret.");
  }
  return env.MODEL_CREDENTIAL_KEY!;
}

async function keyedDigest(keyHex: string, owner: string, vars: readonly RunEnvVar[]): Promise<string> {
  const raw = Uint8Array.from(keyHex.match(/../g)!, (h) => Number.parseInt(h, 16));
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  const macKey = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: DIGEST_INFO },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(JSON.stringify([owner, vars.map((v) => [v.name, v.value])]));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", macKey, message));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sealRunEnv(
  env: Pick<Env, "MODEL_CREDENTIAL_KEY">,
  owner: string,
  raw: unknown,
): Promise<SealedRunEnv> {
  const key = requireKey(env);
  const vars = parseRunEnv(raw);
  const digest = await keyedDigest(key, owner, vars);
  const sealed = await encryptAuthJson(JSON.stringify(vars), key, SCOPE, owner, digest);
  return { sealed, names: vars.map((v) => v.name), digest };
}

/** Throws unless the blob was sealed for this owner with exactly this digest. */
export async function openRunEnv(
  env: Pick<Env, "MODEL_CREDENTIAL_KEY">,
  owner: string,
  sealed: string,
  digest: string,
): Promise<Record<string, string>> {
  const key = requireKey(env);
  let plaintext: string;
  try {
    plaintext = await decryptAuthJson(sealed, key, SCOPE, owner, digest);
  } catch {
    throw new Error("Sealed environment variables do not belong to this run.");
  }
  const vars = parseRunEnv(JSON.parse(plaintext));
  if ((await keyedDigest(key, owner, vars)) !== digest) {
    throw new Error("Sealed environment variables do not match the approved digest.");
  }
  return Object.fromEntries(vars.map((v) => [v.name, v.value]));
}

/** Each scrubbable value in the forms it can surface in: raw, and JSON-escaped inside harness event lines. */
function valueForms(values: Record<string, string>): [string, string][] {
  return Object.entries(values)
    .filter(([, value]) => value.length >= MIN_SCRUB_CHARS)
    .flatMap(([name, value]): [string, string][] => {
      const escaped = JSON.stringify(value).slice(1, -1);
      return escaped === value ? [[name, value]] : [[name, value], [name, escaped]];
    })
    .sort((a, b) => b[1].length - a[1].length);
}

/** Replace each approved value (longest form first) with a placeholder naming its variable. */
export function runEnvScrubber(values: Record<string, string>): (text: string) => string {
  const forms = valueForms(values);
  return (text) => forms.reduce((out, [name, form]) => out.split(form).join(`[redacted:${name}]`), text);
}

/** The name of the first approved value found in `text`, if any. */
function runEnvLeakName(text: string, values: Record<string, string>): string | undefined {
  return valueForms(values).find(([, form]) => text.includes(form))?.[0];
}

/** Only lines the change adds — a value already in the repo (a local dev URL) isn't a leak. */
function addedLines(diff: string): string {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
}

/** The name of the first approved value the diff adds, if any. */
export function runEnvDiffLeakName(diff: string, values: Record<string, string>): string | undefined {
  return runEnvLeakName(addedLines(diff), values);
}

/**
 * Scrub every text field a result carries out of the sandbox. A diff or file
 * holding an approved value can't be scrubbed without corrupting the change,
 * so the run fails and the change is dropped instead of returned or published.
 */
export function guardRunEnvLeak(result: CodingTaskResult, values: Record<string, string>): CodingTaskResult {
  const scrub = runEnvScrubber(values);
  const scrubbed: CodingTaskResult = {
    ...result,
    summary: scrub(result.summary),
    stderrTail: scrub(result.stderrTail),
    ...(result.testEvidence ? { testEvidence: { ...result.testEvidence, outputTail: scrub(result.testEvidence.outputTail) } } : {}),
    ...(result.signals
      ? { signals: result.signals.map((s) => (s.detail !== undefined ? { ...s, detail: scrub(s.detail) } : s)) }
      : {}),
  };
  // Text files show up in the diff's added lines; binary files only through their content.
  const leaked =
    runEnvDiffLeakName(result.diff, values) ??
    result.files
      .filter((f) => f.encoding === "base64" && f.content !== null)
      .map((f) => runEnvLeakName(atob(f.content as string), values))
      .find(Boolean);
  if (leaked === undefined) return scrubbed;
  return {
    ...scrubbed,
    status: "error",
    diff: "",
    files: [],
    changedFiles: [],
    summary: `The change contains the value of approved environment variable ${leaked}; refusing to return or publish it.`,
  };
}
