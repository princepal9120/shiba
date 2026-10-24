import type { Env } from "../env.js";

const DEFAULT_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";

export interface AntigravityOAuthClient {
  clientId: string;
  clientSecret: string;
}

export function resolveAntigravityOAuthClient(env?: Pick<Env, "GOOGLE_ANTIGRAVITY_CLIENT_ID" | "GOOGLE_ANTIGRAVITY_CLIENT_SECRET">): AntigravityOAuthClient {
  const clientId =
    typeof env?.GOOGLE_ANTIGRAVITY_CLIENT_ID === "string" && env.GOOGLE_ANTIGRAVITY_CLIENT_ID.trim() !== ""
      ? env.GOOGLE_ANTIGRAVITY_CLIENT_ID.trim()
      : DEFAULT_CLIENT_ID;
  const clientSecret = env?.GOOGLE_ANTIGRAVITY_CLIENT_SECRET?.trim() ?? "";
  if (clientSecret === "") {
    throw new Error("GOOGLE_ANTIGRAVITY_CLIENT_SECRET is not configured on this deployment.");
  }
  return { clientId, clientSecret };
}
