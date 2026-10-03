/**
 * Worker shim for the built-in dashboard auth lane. The implementation
 * lives in `@shiba/auth` (`packages/auth/src/better-auth.ts`); this module
 * only wires the worker's secret redactor into the package's log paths.
 */
import {
  handleBetterAuth as handleBetterAuthLane,
  resolveBetterAuthUserId as resolveBetterAuthUserIdLane,
} from "@shiba/auth";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

export {
  BETTER_AUTH_BASE_PATH,
  BETTER_AUTH_MIN_SECRET_LENGTH,
  BETTER_AUTH_STATEMENTS,
  betterAuthFor,
  ensureBetterAuthSchema,
  isBetterAuthConfigured,
  isBetterAuthPath,
} from "@shiba/auth";
export type { BetterAuthLaneEnv } from "@shiba/auth";

export async function handleBetterAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  return handleBetterAuthLane(request, env, redactSecrets);
}

export async function resolveBetterAuthUserId(
  request: Request,
  env: Env,
): Promise<string | null> {
  return resolveBetterAuthUserIdLane(request, env, redactSecrets);
}
