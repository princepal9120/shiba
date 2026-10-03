/**
 * Built-in dashboard auth — email+password accounts with signed-cookie
 * sessions via Better Auth, the self-hosted alternative to Cloudflare
 * Access. Dark unless `BETTER_AUTH_SECRET` is set (the library requires
 * ≥32 chars; anything shorter reads as "not configured" and the gate fails
 * closed as before). Mounted at `/api/auth/*`; the subscription-connect
 * routes under `/api/auth/<provider>-subscription` keep their own surface
 * gate and are never claimed by this lane.
 *
 * Tables live in the `AGENT_AUDIT` D1 database alongside `audit_log` — the
 * same provisioned store, self-healed once per isolate exactly like
 * audit.ts (`ensureBetterAuthSchema` runs the idempotent DDL before any
 * auth work, so a fresh deployment needs no manual migration step).
 *
 * Sign-up is bootstrap-only: the `user.create.before` hook refuses account
 * creation once a user row exists, so a public deployment can never grow a
 * second account through the open sign-up route. Operators reset access by
 * clearing the `user` table.
 */
import { APIError, betterAuth } from "better-auth";
import type { Env } from "./env.js";
import { redactSecrets } from "./security.js";

export const BETTER_AUTH_BASE_PATH = "/api/auth";
export const BETTER_AUTH_MIN_SECRET_LENGTH = 32;

/** `/api/auth/<provider>-subscription*` belongs to the T47–T50 connect lanes. */
const SUBSCRIPTION_AUTH_PATH =
  /^\/api\/auth\/(?:claude|codex|cursor|devin|antigravity)-subscription(?:\/|$)/;

export function isBetterAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith(`${BETTER_AUTH_BASE_PATH}/`) &&
    !SUBSCRIPTION_AUTH_PATH.test(pathname)
  );
}

export function isBetterAuthConfigured(env: {
  BETTER_AUTH_SECRET?: string;
}): boolean {
  return (
    typeof env.BETTER_AUTH_SECRET === "string" &&
    env.BETTER_AUTH_SECRET.length >= BETTER_AUTH_MIN_SECRET_LENGTH
  );
}

/**
 * Core Better Auth schema (sqlite) as emitted by `npx auth generate` for
 * 1.7.x — verbatim except `IF NOT EXISTS` so re-runs are no-ops.
 */
export const BETTER_AUTH_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL,
    "image" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "expiresAt" DATE NOT NULL,
    "token" TEXT NOT NULL UNIQUE,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATE,
    "refreshTokenExpiresAt" DATE,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATE NOT NULL,
    "createdAt" DATE NOT NULL,
    "updatedAt" DATE NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session" ("userId")`,
  `CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account" ("userId")`,
  `CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification" ("identifier")`,
];

/** D1/database handles whose auth schema is already ensured in this isolate. */
const schemaInitialized = new WeakSet<object>();

/** Apply the idempotent auth DDL once per isolate per binding. */
export async function ensureBetterAuthSchema(env: {
  AGENT_AUDIT: D1Database;
}): Promise<void> {
  const db = env.AGENT_AUDIT;
  if (schemaInitialized.has(db)) return;
  for (const statement of BETTER_AUTH_STATEMENTS) {
    await db.prepare(statement).run();
  }
  schemaInitialized.add(db);
}

type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
const instances = new WeakMap<Env, BetterAuthInstance>();

// Local dev origins: the vite dev server (:5173) proxies /api to wrangler
// (:8788, sometimes :8787), so the browser's Origin differs from the
// request URL — both must be trusted for sign-in CSRF checks.
const DEV_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:8787",
  "http://localhost:8788",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8787",
  "http://127.0.0.1:8788",
];

function createBetterAuth(env: Env) {
  return betterAuth({
    appName: "shiba",
    // The binding satisfies Better Auth's structural D1Database contract;
    // tests may substitute node:sqlite's DatabaseSync (also supported).
    database: env.AGENT_AUDIT as never,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: BETTER_AUTH_BASE_PATH,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      requireEmailVerification: false,
      minPasswordLength: 8,
    },
    session: {
      // The dashboard calls getSession on every request; a short-lived
      // signed cookie cache keeps routine reads off D1.
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    trustedOrigins: (request?: Request) => {
      const origins = new Set(DEV_ORIGINS);
      if (request) origins.add(new URL(request.url).origin);
      if (env.BETTER_AUTH_URL) {
        try {
          origins.add(new URL(env.BETTER_AUTH_URL).origin);
        } catch {
          // malformed BETTER_AUTH_URL — dev origins + request origin still apply
        }
      }
      return [...origins];
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const row = await env.AGENT_AUDIT.prepare(
              `SELECT COUNT(*) AS c FROM "user"`,
            ).first<{ c: number }>();
            if ((row?.c ?? 0) === 0) return { data: user };
            throw new APIError("FORBIDDEN", {
              message: "Sign-up is closed — an account already exists.",
            });
          },
        },
      },
    },
    telemetry: { enabled: false },
  });
}

/** One instance per isolate/env — construction validates config once. */
export function betterAuthFor(env: Env): BetterAuthInstance {
  let instance = instances.get(env);
  if (!instance) {
    instance = createBetterAuth(env);
    instances.set(env, instance);
  }
  return instance;
}

/**
 * `/api/auth/*` route surface (sign-in, sign-up, session verbs, sign-out).
 * Returns null when the lane is dark so index.ts falls through to the API
 * 404; 503 when the lane is on but its D1 store is missing — that is a
 * deploy misconfiguration, not "unauthenticated".
 */
export async function handleBetterAuth(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!isBetterAuthPath(url.pathname) || !isBetterAuthConfigured(env)) {
    return null;
  }
  if (env.AGENT_AUDIT === undefined) {
    return Response.json(
      { error: "Auth storage is not configured." },
      { status: 503 },
    );
  }
  try {
    await ensureBetterAuthSchema(env);
    return await betterAuthFor(env).handler(request);
  } catch (error) {
    console.error(
      redactSecrets(error instanceof Error ? error.message : String(error)),
    );
    return Response.json({ error: "Auth request failed." }, { status: 500 });
  }
}

/**
 * Verified dashboard identity for the built-in lane: the session user's
 * email, or null. Any failure (missing tables, bad cookie, D1 outage)
 * resolves to null — the caller fails closed.
 */
export async function resolveBetterAuthUserId(
  request: Request,
  env: Env,
): Promise<string | null> {
  if (!isBetterAuthConfigured(env) || env.AGENT_AUDIT === undefined) {
    return null;
  }
  try {
    await ensureBetterAuthSchema(env);
    const session = await betterAuthFor(env).api.getSession({
      headers: request.headers,
    });
    const email = session?.user?.email;
    return typeof email === "string" && email.trim() !== "" ? email.trim() : null;
  } catch (error) {
    console.warn(
      `better-auth session check failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`,
    );
    return null;
  }
}
