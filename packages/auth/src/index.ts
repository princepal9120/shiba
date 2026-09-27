/**
 * @shiba/auth — Worker-facing auth services. The flow types themselves
 * live in @shiba/shared (harnesses read them across the boundary rule);
 * this package holds the implementation. Re-exported for one-import
 * consumers.
 */
export * from "./controller.js";
export type { AuthPhase, AuthSnapshot, ProviderAuthController } from "@shiba/shared";
