/**
 * Vitest stub for `cloudflare:*` specifier imports. Modules like
 * `agents/mcp` pull `cloudflare:workers` transitively, which Node's ESM
 * loader cannot resolve — vitest.config.ts aliases every `cloudflare:*`
 * specifier here. These exports only need to satisfy named bindings at
 * module-eval time; tests that exercise real behavior mock the boundary
 * module (e.g. `agents/mcp` itself) instead of relying on these classes.
 */
export class DurableObject<Env = unknown> {
  constructor(
    protected ctx: unknown,
    protected env: Env,
  ) {}
}
export class RpcTarget {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export class WorkflowEvent {}
export class WorkflowSleepDuration {}
export class EmailMessage {}
export const env = {};
export const tracing = {};
export const exports = {};
export default {};
