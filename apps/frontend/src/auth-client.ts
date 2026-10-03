/**
 * Better Auth client for the built-in dashboard login lane. Same-origin:
 * the Worker serves /api/auth/* itself, so no baseURL/basePath options are
 * needed — the defaults are exactly right.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();
