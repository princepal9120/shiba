import type { Env } from "./env.js";
import { resolveInstanceType } from "./instance-type.js";

/** Fail deploy/dev loudly if wrangler vars still name a retired model. */
const RETIRED_CODING_MODELS = new Set(["google/gemini-2.0-flash"]);

export function assertLiveCodingModel(env: Env): void {
  if (RETIRED_CODING_MODELS.has(env.CODING_MODEL)) {
    throw new Error(
      `CODING_MODEL ${env.CODING_MODEL} is retired. Set wrangler.jsonc vars.CODING_MODEL to a live id.`,
    );
  }
  resolveInstanceType(env.INSTANCE_TYPE);
}
