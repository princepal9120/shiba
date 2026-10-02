/**
 * Per-role delegation vocabulary (T52). Shiba delegates work in roles —
 * which agent CLI + model runs each role is an operator pin resolved
 * Worker-side (`agents/roles.ts`); the union lives here because the
 * approval record and the coding-task envelope both carry it, and the
 * dashboard projects the same wire shape.
 */
export const AGENT_ROLES = ["orchestrator", "explorer", "fixer", "reviewer", "designer"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(value: unknown): value is AgentRole {
  return typeof value === "string" && (AGENT_ROLES as readonly string[]).includes(value);
}
