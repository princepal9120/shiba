/**
 * ACP registry resolver (PLAN-V2-NEXT): a run can name ANY agent in the
 * ACP registry — `acp/<agent-id>` as the coding model — and the worker
 * resolves it to a spawnable spec for the shared ACP driver (acp.ts).
 *
 * Resolution is deliberately synchronous and offline: the registry comes
 * from `ACP_REGISTRY_JSON`, an operator-pinned snapshot of
 * `cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (fetch it
 * and store it like a lockfile — the DO decide path never egresses to a
 * third-party index at admit time). `ACP_REGISTRY_ALLOWLIST` decides which
 * ids may spawn at all; absent or empty, the `acp` harness is dark.
 *
 * Registry schema (agentclientprotocol/registry FORMAT.md):
 *   { version, agents: [{ id, name, version, distribution:
 *     { binary: {<platform>: {archive, cmd, args?, env?, sha256?}},
 *       npx:   {package, args?, env?},
 *       uvx:   {package, args?, env?} } }] }
 *
 * `acp/<id>` may carry a pin as `acp/<id>@<version>` — the registry
 * snapshot lists one version per id, so a mismatched pin refuses rather
 * than silently running a different release.
 */
import { z } from "zod";
import { AcpHarness, parseAcpDriverEvent, type AcpHarnessSpec } from "./acp.js";
import {
  assertSupportedModel,
  providerOf,
  verifyRunOutcome,
  type AgentHarness,
  type RuntimeName,
} from "./types.js";

export class AcpRegistryError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "AcpRegistryError";
  }
}

/** Thrown when the id is not in ACP_REGISTRY_ALLOWLIST. */
export class AcpRegistryNotAllowed extends AcpRegistryError {
  constructor(id: string) {
    super(
      `ACP registry agent ${JSON.stringify(id)} is not allowlisted — ` +
        `add it to ACP_REGISTRY_ALLOWLIST (comma-separated ids, "*" = all).`,
    );
    this.name = "AcpRegistryNotAllowed";
  }
}

/** Registry id grammar per the registry FORMAT. */
export const ACP_AGENT_ID_RE = /^[a-z][a-z0-9-]*$/;

const agentIdSchema = z.string().regex(ACP_AGENT_ID_RE);
const stringList = z.array(z.string()).optional();
const envBlock = z.record(z.string(), z.string()).optional();

const npxDistributionSchema = z.strictObject({
  package: z.string().min(1),
  args: stringList,
  env: envBlock,
});
const uvxDistributionSchema = npxDistributionSchema;
const binaryTargetSchema = z.strictObject({
  archive: z.string().url(),
  cmd: z.string().min(1),
  args: stringList,
  env: envBlock,
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
const distributionSchema = z.strictObject({
  binary: z.record(z.string(), binaryTargetSchema).optional(),
  npx: npxDistributionSchema.optional(),
  uvx: uvxDistributionSchema.optional(),
});
const registryAgentSchema = z.strictObject({
  id: agentIdSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  distribution: distributionSchema,
});
const registrySchema = z.strictObject({
  version: z.string().min(1),
  agents: z.array(registryAgentSchema),
});

export type AcpRegistryAgent = z.infer<typeof registryAgentSchema>;
export type AcpRegistry = z.infer<typeof registrySchema>;

/** Parse an operator-pinned registry snapshot. Throws AcpRegistryError. */
export function parseAcpRegistry(json: string): AcpRegistry {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AcpRegistryError("ACP_REGISTRY_JSON is not valid JSON.");
  }
  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AcpRegistryError(
      `ACP_REGISTRY_JSON does not match the registry schema (${issue?.path.join(".") ?? "root"}: ${issue?.message ?? "invalid"}).`,
    );
  }
  return parsed.data;
}

/** Parse `a,b,c` / `*` allowlist syntax. */
export function parseAcpAllowlist(raw: string | undefined): Set<string> | "all" | null {
  if (raw === undefined || raw.trim() === "") return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (ids.includes("*")) return "all";
  for (const id of ids) {
    if (!ACP_AGENT_ID_RE.test(id)) {
      throw new AcpRegistryError(`ACP_REGISTRY_ALLOWLIST entry ${JSON.stringify(id)} is not a registry id.`);
    }
  }
  return new Set(ids);
}

/** Whether the `acp` harness is enabled at all on this deployment. */
export function acpRegistryEnabled(env: { ACP_REGISTRY_ALLOWLIST?: string } | undefined): boolean {
  return parseAcpAllowlist(env?.ACP_REGISTRY_ALLOWLIST) !== null;
}

/** `acp/<id>[@version]` → {id, version?}. null when the model isn't acp. */
export function acpModelToAgentId(model: string): { id: string; version?: string } | null {
  if (providerOf(model) !== "acp") return null;
  const rest = model.slice(4);
  const at = rest.indexOf("@");
  const id = at === -1 ? rest : rest.slice(0, at);
  if (!ACP_AGENT_ID_RE.test(id)) {
    throw new AcpRegistryError(`ACP model ${JSON.stringify(model)} does not name a registry id (acp/<id>[@version]).`);
  }
  return at === -1 ? { id } : { id, version: rest.slice(at + 1) };
}

/** How the resolved agent reaches the container. */
export type AcpInstall =
  | { kind: "npx"; package: string }
  | { kind: "uvx"; package: string }
  | { kind: "binary"; url: string; sha256?: string };

export interface AcpResolvedAgent {
  agent: { id: string; name: string; version: string };
  /** The argv the shared ACP driver spawns. */
  spawn: { command: string; args: string[]; env: Record<string, string> };
  /** Origin to install from, when the agent isn't on PATH already. */
  install: AcpInstall;
  /** Egress hosts the install needs (package index or archive origin). */
  installHosts: string[];
}

/** The platform the sandbox image ships as. Multi-arch manifests mean the
 * host may be arm64 — resolution prefers the requested platform, falls back
 * to the other linux arch, and errors when neither is published. */
const PLATFORM_FALLBACKS: Record<string, string[]> = {
  "linux-x86_64": ["linux-x86_64", "linux-aarch64"],
  "linux-aarch64": ["linux-aarch64", "linux-x86_64"],
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function pickDistribution(
  agent: AcpRegistryAgent,
  platform: string,
): { install: AcpInstall; command: string; args: string[]; env: Record<string, string>; installHosts: string[] } {
  const dist = agent.distribution;
  for (const plat of PLATFORM_FALLBACKS[platform] ?? [platform]) {
    const target = dist.binary?.[plat];
    if (target) {
      // cmd like "./amp-acp" is relative to the archive's unpack dir;
      // the image install path lands it under /opt/acp-agents/<id>/.
      const cmd = target.cmd.replace(/^\.\//, `/opt/acp-agents/${agent.id}/`);
      return {
        install: { kind: "binary", url: target.archive, ...(target.sha256 ? { sha256: target.sha256 } : {}) },
        command: cmd,
        args: target.args ?? [],
        env: target.env ?? {},
        installHosts: [hostOf(target.archive)].filter(Boolean),
      };
    }
  }
  if (dist.npx) {
    // Registry entries already carry the version in the package spec
    // (`@scope/pkg@0.86.0`); we run it verbatim — the snapshot is the pin.
    return {
      install: { kind: "npx", package: dist.npx.package },
      command: "npx",
      args: ["-y", dist.npx.package, ...(dist.npx.args ?? [])],
      env: dist.npx.env ?? {},
      installHosts: ["registry.npmjs.org"],
    };
  }
  if (dist.uvx) {
    return {
      install: { kind: "uvx", package: dist.uvx.package },
      command: "uvx",
      args: [dist.uvx.package, ...(dist.uvx.args ?? [])],
      env: dist.uvx.env ?? {},
      installHosts: ["pypi.org"],
    };
  }
  throw new AcpRegistryError(
    `ACP agent ${agent.id} has no distribution for ${platform} (published: ${[
      ...Object.keys(dist.binary ?? {}),
      ...(dist.npx ? ["npx"] : []),
      ...(dist.uvx ? ["uvx"] : []),
    ].join(", ") || "none"}).`,
  );
}

/**
 * Resolve `{id, version?, platform?}` against a parsed registry snapshot.
 * Pure — the allowlist decision lives in {@link assertAcpAgentAllowed}.
 */
export function resolveAcpAgent(
  registry: AcpRegistry,
  spec: { id: string; version?: string; platform?: string },
): AcpResolvedAgent {
  const agent = registry.agents.find((a) => a.id === spec.id);
  if (!agent) {
    throw new AcpRegistryError(`ACP registry agent ${JSON.stringify(spec.id)} is not in the pinned registry.`);
  }
  if (spec.version !== undefined && spec.version !== agent.version) {
    throw new AcpRegistryError(
      `ACP registry pins ${agent.id} at ${agent.version} — ${spec.version} is not listed; repin ACP_REGISTRY_JSON to change versions.`,
    );
  }
  const picked = pickDistribution(agent, spec.platform ?? "linux-x86_64");
  return {
    agent: { id: agent.id, name: agent.name, version: agent.version },
    spawn: { command: picked.command, args: picked.args, env: picked.env },
    install: picked.install,
    installHosts: picked.installHosts,
  };
}

export function assertAcpAgentAllowed(id: string, env: { ACP_REGISTRY_ALLOWLIST?: string } | undefined): void {
  const allow = parseAcpAllowlist(env?.ACP_REGISTRY_ALLOWLIST);
  if (allow === "all") return;
  if (allow === null || !allow.has(id)) {
    throw new AcpRegistryNotAllowed(id);
  }
}

type AcpRegistryEnv = {
  ACP_REGISTRY_ALLOWLIST?: string;
  ACP_REGISTRY_JSON?: string;
};

/**
 * The generic `acp` harness: `acp/<registry-id>` as the model id resolves
 * through the operator-pinned registry snapshot into a spawn spec the
 * shared ACP driver runs. Everything delegates to `AcpHarness` once the
 * spec exists — the only new machinery is id → argv resolution + the
 * allowlist gate.
 *
 * Env is bound at `resolveHarness` time (the constructor arg); the static
 * sentinel in HARNESSES carries no env — surfaces that only need the
 * declaration (supportedProviders, capabilities) work env-free, while
 * resolution-dependent methods refuse clearly if somehow called on it.
 */
export class AcpRegistryHarness implements AgentHarness {
  constructor(private readonly deployEnv: AcpRegistryEnv | undefined) {}

  get name() {
    return "acp" as const;
  }

  get supportedProviders(): readonly string[] {
    return ["acp"];
  }

  private delegateFor(model: string): { harness: AcpHarness; install: AcpInstall } {
    if (this.deployEnv === undefined) {
      throw new AcpRegistryError("The acp harness requires deployment env — resolve it via resolveHarness().");
    }
    const ref = acpModelToAgentId(model);
    if (ref === null) {
      throw new AcpRegistryError(`ACP models take the acp/<registry-id> form; got ${JSON.stringify(model)}.`);
    }
    assertAcpAgentAllowed(ref.id, this.deployEnv);
    if (this.deployEnv.ACP_REGISTRY_JSON === undefined) {
      throw new AcpRegistryError("ACP_REGISTRY_JSON is unset — pin a registry snapshot to resolve acp/ models.");
    }
    const resolved = resolveAcpAgent(parseAcpRegistry(this.deployEnv.ACP_REGISTRY_JSON), {
      id: ref.id,
      ...(ref.version !== undefined ? { version: ref.version } : {}),
    });
    const spec: AcpHarnessSpec = {
      name: "acp",
      label: `${resolved.agent.name} (registry)`,
      spawn: [resolved.spawn.command, ...resolved.spawn.args],
      providers: ["acp"],
      // No single provider key exists for an arbitrary registry agent —
      // the credential invariant degenerates to a neutral dummy var; the
      // allowlist + install-origin hosts are the real boundary here.
      keyEnv: "ACP_AGENT_API_KEY",
      extraEgress: resolved.installHosts,
      // The registry manifest's env block passes through verbatim — it
      // declares what the agent binary reads.
      extraEnv: () => resolved.spawn.env,
    };
    return { harness: new AcpHarness(spec), install: resolved.install };
  }

  egressHosts(model: string): string[] {
    assertSupportedModel("acp", this.supportedProviders, model);
    return this.delegateFor(model).harness.egressHosts(model);
  }

  configFile(input: Parameters<AcpHarness["configFile"]>[0], sandboxId: string) {
    return this.delegateFor(input.codingModel).harness.configFile(input, sandboxId);
  }

  env(input: Parameters<AcpHarness["env"]>[0], configPath: string | null = null) {
    return this.delegateFor(input.codingModel).harness.env(input, configPath);
  }

  buildArgv(input: Parameters<AcpHarness["buildArgv"]>[0], workdir: string) {
    return this.delegateFor(input.codingModel).harness.buildArgv(input, workdir);
  }

  parseEvent(line: string) {
    return parseAcpDriverEvent(line, "ACP registry agent");
  }

  capabilities() {
    return {
      streamsText: true,
      emitsToolCalls: true,
      supportsResume: false,
      supportsSteering: false,
      supportsFileAttachments: false,
      canRunTests: false,
      supportsConversationRollback: false,
      execAllowlist: [],
      supportedRuntimes: ["sandbox"] as RuntimeName[],
    };
  }

  async verify(input: Parameters<AcpHarness["verify"]>[0], result: Parameters<AcpHarness["verify"]>[1]) {
    // Verification only needs the declared capabilities — identical for
    // every resolved agent — so the env-free sentinel can verify too.
    return verifyRunOutcome(input, result, this.capabilities());
  }
}
