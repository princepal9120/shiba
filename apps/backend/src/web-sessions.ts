/**
 * Web-Session routing, lifecycle, and listing/resume primitives.
 *
 * Implements T30/T32 web-session support for safe per-user multiple named
 * CodingOrchestrator sessions.
 *
 * Security & Routing Invariants:
 * 1. Base session compatibility: The default orchestrator DO named `userId`
 *    (or "default" in local dev) remains reachable and compatible.
 * 2. Scoped naming: Named web sessions use the DO name pattern
 *    `web:${userId}:${sessionId}`, ensuring each user's sessions are isolated
 *    and cannot be targeted or hijacked by another authenticated user.
 * 3. Server-minted IDs: Session IDs are strictly generated on the server as
 *    UUIDv4 values to prevent client injection, path traversal, or collisions.
 * 4. Safe authorization: `isAuthorizedSessionAgent` ensures only the owning user
 *    can route WebSocket or HTTP requests to an orchestrator instance.
 */

export const WEB_SESSION_PREFIX = "web:";
export const DEFAULT_SESSION_ID = "default";
export const DEFAULT_SESSION_NAME = "Default Session";
export const MAX_SESSIONS_PER_USER = 100;

export const MAX_METADATA_KEYS = 20;
export const MAX_METADATA_KEY_LENGTH = 64;
export const MAX_METADATA_VALUE_LENGTH = 1024;
export const MAX_METADATA_TOTAL_BYTES = 8192;

export const SESSION_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebSessionRecord {
  id: string;
  userId: string;
  name: string;
  agentName: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
  /**
   * Tombstone timestamp set before session teardown begins. A marked session
   * is invisible to listing/lookup/routing so no new work (runs queue or
   * WebSocket connects) can be admitted while teardown is in flight. The
   * mark is cleared only if a non-force teardown fails and the delete is
   * rolled back.
   */
  deletingAt?: number;
}

export interface CreateWebSessionOptions {
  name?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Server-mints a cryptographically secure random session ID (UUIDv4).
 */
export function mintSessionId(): string {
  return crypto.randomUUID();
}

/**
 * Validates whether a string is a valid session ID.
 * Accepts "default" (base session) or standard UUID format.
 * Strictly rejects path traversals, control characters, colons, or slashes.
 */
export function isValidSessionId(id: string): boolean {
  if (typeof id !== "string") return false;
  if (id === DEFAULT_SESSION_ID) return true;
  return SESSION_UUID_REGEX.test(id);
}

/**
 * Sanitizes a user-supplied session name/title.
 * Trims whitespace, strips non-printable control characters, and limits length.
 */
export function sanitizeSessionName(name: unknown): string {
  if (typeof name !== "string") return "";
  // Strip control characters (ASCII 0-31 and 127)
  let cleaned = "";
  for (const ch of name) {
    const code = ch.codePointAt(0)!;
    if (code > 0x1f && code !== 0x7f) cleaned += ch;
  }
  return cleaned.trim().slice(0, 100);
}

/**
 * Sanitizes and bounds session metadata to prevent resource exhaustion or arbitrary storage.
 * Enforces plain object, primitive values only, key/value length limits, and total byte ceiling.
 */
export function sanitizeSessionMetadata(
  raw: unknown,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Session metadata must be a plain object.");
  }
  // Check prototype to ensure it is a plain object
  const proto = Object.getPrototypeOf(raw);
  if (proto !== null && proto !== Object.prototype) {
    throw new Error("Session metadata must be a plain object.");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (entries.length > MAX_METADATA_KEYS) {
    throw new Error(`Session metadata exceeds key limit (${MAX_METADATA_KEYS}).`);
  }
  const encoder = new TextEncoder();
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key.trim().length === 0 || key.length > MAX_METADATA_KEY_LENGTH) {
      throw new Error(`Invalid metadata key: "${key.slice(0, 16)}...".`);
    }
    if (typeof value === "string") {
      // Byte-accurate limit: multi-byte UTF-8 characters can exceed
      // MAX_METADATA_VALUE_LENGTH bytes well under the char count.
      if (value.length > MAX_METADATA_VALUE_LENGTH ||
          encoder.encode(value).byteLength > MAX_METADATA_VALUE_LENGTH) {
        throw new Error(`Metadata value for "${key}" exceeds limit (${MAX_METADATA_VALUE_LENGTH} bytes).`);
      }
      sanitized[key] = value;
    } else if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        throw new Error(`Metadata number for "${key}" must be finite.`);
      }
      sanitized[key] = value;
    } else if (typeof value === "boolean" || value === null) {
      sanitized[key] = value;
    } else {
      throw new Error(`Metadata value for "${key}" must be a string, number, boolean, or null.`);
    }
  }
  const serialized = JSON.stringify(sanitized);
  const byteLength = encoder.encode(serialized).byteLength;
  if (byteLength > MAX_METADATA_TOTAL_BYTES) {
    throw new Error(`Session metadata exceeds size limit (${MAX_METADATA_TOTAL_BYTES} bytes).`);
  }
  return sanitized;
}

/**
 * Validates a stored/persisted session record's structural integrity before it
 * is accepted into the registry. Returns an error string or null when valid.
 * `expectedUserId` is the owning base orchestrator's identity when known.
 */
export function validateSessionRecordIntegrity(
  session: unknown,
  expectedUserId?: string,
): string | null {
  if (typeof session !== "object" || session === null || Array.isArray(session)) {
    return "Invalid session record.";
  }
  const s = session as Partial<WebSessionRecord>;
  // Only server-minted UUID session IDs are ever stored in the registry; the
  // base session ("default") is synthetic and never persisted, which also
  // guarantees the `web:<user>:default` alias can never resolve to a record.
  if (typeof s.id !== "string" || !SESSION_UUID_REGEX.test(s.id)) {
    return "Invalid session id.";
  }
  if (typeof s.userId !== "string" || s.userId.trim().length === 0) {
    return "Invalid session userId.";
  }
  if (expectedUserId && s.userId !== expectedUserId) {
    return "Session userId does not match this orchestrator.";
  }
  if (typeof s.name !== "string" || s.name.length === 0 || s.name.length > 100) {
    return "Invalid session name.";
  }
  if (typeof s.agentName !== "string" || s.agentName !== buildSessionAgentName(s.userId, s.id)) {
    return "Session agentName does not match id/userId.";
  }
  if (typeof s.createdAt !== "number" || !Number.isFinite(s.createdAt) || s.createdAt < 0 ||
      typeof s.updatedAt !== "number" || !Number.isFinite(s.updatedAt) || s.updatedAt < 0) {
    return "Invalid session timestamps.";
  }
  if (s.deletingAt !== undefined &&
      (typeof s.deletingAt !== "number" || !Number.isFinite(s.deletingAt) || s.deletingAt < 0)) {
    return "Invalid session deletingAt.";
  }
  return null;
}

/**
 * Constructs the Durable Object agent name for a CodingOrchestrator instance.
 * For the base session ("default"), returns `userId` to preserve compatibility.
 * For named sessions, returns `web:${userId}:${sessionId}`.
 */
export function buildSessionAgentName(userId: string, sessionId: string): string {
  const cleanUserId = userId.trim();
  if (!cleanUserId) {
    throw new Error("Cannot build session agent name: missing userId.");
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error(`Cannot build session agent name: invalid sessionId "${sessionId}".`);
  }
  if (sessionId === DEFAULT_SESSION_ID) {
    return cleanUserId;
  }
  return `${WEB_SESSION_PREFIX}${cleanUserId}:${sessionId}`;
}

/**
 * Parses a `web:${userId}:${sessionId}` DO name.
 * Returns null if the agent name is not a web session or is malformed.
 */
export function parseSessionAgentName(
  agentName: string,
): { userId: string; sessionId: string } | null {
  if (typeof agentName !== "string" || !agentName.startsWith(WEB_SESSION_PREFIX)) {
    return null;
  }
  const rest = agentName.slice(WEB_SESSION_PREFIX.length);
  const lastColon = rest.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === rest.length - 1) {
    return null;
  }
  const userId = rest.slice(0, lastColon);
  const sessionId = rest.slice(lastColon + 1);
  // Strictly disallow DEFAULT_SESSION_ID in named web session agent names;
  // the base session is always named directly after userId.
  if (!isValidSessionId(sessionId) || sessionId === DEFAULT_SESSION_ID) {
    return null;
  }
  return { userId, sessionId };
}

/**
 * Checks whether an incoming request from `authenticatedUserId` is authorized
 * to route to the CodingOrchestrator DO named `agentName`.
 *
 * Rules:
 * 1. Base session compatibility: if `agentName === authenticatedUserId`, authorized.
 * 2. Named web session: if `agentName` is `web:${userId}:${sessionId}`, authorized
 *    if and only if `userId === authenticatedUserId` and `sessionId` is valid.
 * 3. All other names (e.g. another user's base/web session, Slack threads,
 *    automations DO names) return false.
 */
export function isAuthorizedSessionAgent(
  agentName: string,
  authenticatedUserId: string,
): boolean {
  if (!agentName || typeof agentName !== "string") return false;
  if (!authenticatedUserId || typeof authenticatedUserId !== "string") return false;

  // Base session compatibility
  if (agentName === authenticatedUserId) {
    return true;
  }

  // Named web session
  if (agentName.startsWith(WEB_SESSION_PREFIX)) {
    const parsed = parseSessionAgentName(agentName);
    if (!parsed) return false;
    return parsed.userId === authenticatedUserId && isValidSessionId(parsed.sessionId);
  }

  return false;
}

/**
 * T51: whether this orchestrator DO name is a dashboard surface. The local
 * runtime is operator-initiated from the dashboard only, so this predicate
 * is a positive list of the two dashboard shapes — never a fallthrough:
 *
 * 1. `<userId>` — the base user DO (also what the authenticated /api/runs
 *    route resolves to). A bare user id carries no lane prefix: anything
 *    with a colon is a lane DO (`slack:*` threads, `discord:`/`telegram:`/
 *    `web:<id>` chat conversations, any future `<lane>:` prefix), not a
 *    user.
 * 2. `web:<userId>:<sessionId>` — a named web session, in the strict
 *    two-segment shape parseSessionAgentName accepts. A one-segment
 *    `web:<id>` chat-thread DO parses to null and is refused like the
 *    other chat lanes.
 *
 * The shared `default` DO that MCP/email/automations intake posts to has
 * no prefix and is not a user id, so it stays a non-dashboard surface.
 *
 * Note the asymmetry: `<userId>` is dashboard-able only because the same
 * name is also what the authenticated `/api/runs` route resolves to — the
 * intake side additionally requires the Worker-stamped X-Shiba-Intake
 * header, so a chat surface can never reach this predicate's "true" branch
 * through queueSlackRun even when its DO name happens to be a user id.
 */
export function isDashboardAgentName(agentName: string | undefined): boolean {
  if (typeof agentName !== "string" || agentName === "") return false;
  if (agentName.startsWith(WEB_SESSION_PREFIX)) {
    return parseSessionAgentName(agentName) !== null;
  }
  if (agentName === DEFAULT_SESSION_ID) return false;
  return !agentName.includes(":");
}

/**
 * Returns the synthetic base session record for a user.
 */
export function getBaseSessionRecord(userId: string): WebSessionRecord {
  return {
    id: DEFAULT_SESSION_ID,
    userId,
    name: DEFAULT_SESSION_NAME,
    agentName: userId,
    createdAt: 0,
    updatedAt: 0,
  };
}

/**
 * Creates and server-mints a new named WebSessionRecord.
 */
export function createWebSession(
  userId: string,
  options?: CreateWebSessionOptions,
): WebSessionRecord {
  const cleanUserId = userId.trim();
  if (!cleanUserId) {
    throw new Error("Cannot create session: missing userId.");
  }
  const id = mintSessionId();
  const sanitizedName = sanitizeSessionName(options?.name);
  const name = sanitizedName || `Session ${id.slice(0, 8)}`;
  const agentName = buildSessionAgentName(cleanUserId, id);
  const metadata = sanitizeSessionMetadata(options?.metadata);
  const now = Date.now();

  return {
    id,
    userId: cleanUserId,
    name,
    agentName,
    createdAt: now,
    updatedAt: now,
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Prepares the complete session list for a user, ensuring the base session
 * is present and user-scoped sessions are sorted by recency.
 */
export function formatSessionList(
  userId: string,
  storedSessions: WebSessionRecord[] = [],
): WebSessionRecord[] {
  const baseSession = getBaseSessionRecord(userId);
  const userSessions = storedSessions
    .filter((s) => s.userId === userId && s.id !== DEFAULT_SESSION_ID && isValidSessionId(s.id) && !s.deletingAt)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  return [baseSession, ...userSessions];
}

/**
 * Resolves a session by ID for a user.
 */
export function findSession(
  userId: string,
  storedSessions: WebSessionRecord[],
  sessionId: string,
): WebSessionRecord | null {
  if (sessionId === DEFAULT_SESSION_ID) {
    return getBaseSessionRecord(userId);
  }
  const found = storedSessions.find(
    (s) => s.userId === userId && s.id === sessionId && !s.deletingAt,
  );
  return found ?? null;
}
