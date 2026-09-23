/**
 * Cloudflare Containers instance size. Deploy-time only: wrangler
 * `containers.instance_type` and `vars.INSTANCE_TYPE` must match.
 * Cloudbox exposes this as a var so a large monorepo can bump to
 * standard-2 without a code change.
 */
export const INSTANCE_TYPES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"] as const;

export type InstanceType = (typeof INSTANCE_TYPES)[number];

export const DEFAULT_INSTANCE_TYPE: InstanceType = "standard-1";

export function resolveInstanceType(raw: string | undefined): InstanceType {
  if (raw === undefined || raw === "") return DEFAULT_INSTANCE_TYPE;
  if ((INSTANCE_TYPES as readonly string[]).includes(raw)) return raw as InstanceType;
  throw new Error(
    `Unknown INSTANCE_TYPE ${JSON.stringify(raw)}: expected ${INSTANCE_TYPES.join(", ")}.`,
  );
}
