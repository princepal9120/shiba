/**
 * T52 Worker-boundary validation for the daemon fleet wire shapes. Effect
 * Schema, not zod: the shared module stays plain interfaces (see
 * packages/shared/src/local-fleet.ts) and the asserts below pin the two together.
 */
import { Schema } from "effect";
import type { ConnectedComputer, HeartbeatRequest, PairRequest } from "@shiba/shared";

const Bounded = (max: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(max));
const Harnesses = Schema.Array(Bounded(32)).check(Schema.isMaxLength(16));

export const HeartbeatRequestSchema = Schema.Struct({
  machineId: Bounded(64),
  hostname: Bounded(255),
  platform: Bounded(64),
  daemonVersion: Bounded(64),
  harnesses: Harnesses,
  activeRunId: Schema.optional(Bounded(200)),
});

export const PairRequestSchema = Schema.Struct({
  pairingToken: Bounded(1024),
  hostname: Bounded(255),
  platform: Bounded(64),
  daemonVersion: Bounded(64),
  harnesses: Harnesses,
});

export const ConnectedComputerSchema = Schema.Struct({
  machineId: Schema.String,
  hostname: Schema.String,
  platform: Schema.String,
  daemonVersion: Schema.String,
  harnesses: Schema.Array(Schema.String),
  status: Schema.Literals(["idle", "busy", "offline"]),
  lastHeartbeat: Schema.Number,
  pairedAt: Schema.optional(Schema.Number),
  activeRunId: Schema.optional(Schema.String),
});

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const assertSame = <T extends true>(): T => true as T;
assertSame<Same<Mutable<typeof HeartbeatRequestSchema.Type>, HeartbeatRequest>>();
assertSame<Same<Mutable<typeof PairRequestSchema.Type>, PairRequest>>();
assertSame<Same<Mutable<typeof ConnectedComputerSchema.Type>, ConnectedComputer>>();

/** The decoded value or null — callers answer 400 on null. */
export function decodeOrNull<S extends Schema.Top>(schema: S, input: unknown): S["Type"] | null {
  try {
    return Schema.decodeUnknownSync(schema as never)(input) as S["Type"];
  } catch {
    return null;
  }
}
