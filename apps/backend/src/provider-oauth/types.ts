export type UserOAuthProvider = "antigravity" | "cursor" | "xai";

export interface UserOAuthRecord {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email?: string;
  accountId?: string;
  /** Antigravity Cloud Code Assist project id. */
  projectId?: string;
  savedAt: number;
}

export interface PendingPkceSignIn {
  state: string;
  /** AES-GCM blob — never store the raw PKCE verifier in DO storage. */
  codeVerifierCipher: string;
  redirectUri: string;
  createdAt: number;
  /** xAI OIDC nonce echoed in id_token. */
  nonce?: string;
}

export interface PendingCursorSignIn {
  uuid: string;
  verifierCipher: string;
  createdAt: number;
}
