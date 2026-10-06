import { describe, expect, it } from "vitest";
import {
  AcpRegistryError,
  AcpRegistryHarness,
  AcpRegistryNotAllowed,
  acpModelToAgentId,
  acpRegistryEnabled,
  assertAcpAgentAllowed,
  parseAcpAllowlist,
  parseAcpRegistry,
  resolveAcpAgent,
  type AcpRegistry,
} from "../src/harness/acp-registry.js";
import { resolveHarness } from "../src/harness/index.js";

const SHA = "a".repeat(64);

const REGISTRY: AcpRegistry = {
  version: "1.0.0",
  agents: [
    {
      id: "claude-acp",
      name: "Claude ACP",
      version: "0.86.0",
      distribution: {
        npx: { package: "@agentclientprotocol/claude-agent-acp@0.86.0" },
      },
    },
    {
      id: "amp-acp",
      name: "Amp ACP",
      version: "1.2.3",
      distribution: {
        binary: {
          "linux-x86_64": {
            archive: "https://ampcode.com/install/amp-acp-linux-x86_64.tar.gz",
            cmd: "./amp-acp",
            env: { AMP_LOG: "warn" },
            sha256: SHA,
          },
          "darwin-aarch64": {
            archive: "https://ampcode.com/install/amp-acp-darwin-aarch64.tar.gz",
            cmd: "./amp-acp",
            sha256: SHA,
          },
        },
      },
    },
    {
      id: "fast-agent",
      name: "Fast Agent",
      version: "0.5.0",
      distribution: {
        uvx: { package: "fast-agent-mcp", args: ["--serve"] },
      },
    },
  ],
};

const ALLOWED_ENV = {
  ACP_REGISTRY_ALLOWLIST: "claude-acp,amp-acp",
  ACP_REGISTRY_JSON: JSON.stringify(REGISTRY),
};

describe("parseAcpRegistry", () => {
  it("rejects invalid JSON", () => {
    expect(() => parseAcpRegistry("{nope")).toThrow(AcpRegistryError);
  });

  it("rejects a schema mismatch with a path hint", () => {
    expect(() => parseAcpRegistry(JSON.stringify({ version: "1", agents: [{ id: "x" }] }))).toThrow(
      /agents\.0\.name|registry schema/,
    );
  });

  it("round-trips a real-shaped registry", () => {
    expect(parseAcpRegistry(JSON.stringify(REGISTRY)).agents).toHaveLength(3);
  });
});

describe("parseAcpAllowlist / acpRegistryEnabled", () => {
  it("absent or empty keeps the lane dark", () => {
    expect(parseAcpAllowlist(undefined)).toBeNull();
    expect(parseAcpAllowlist("  ")).toBeNull();
    expect(acpRegistryEnabled(undefined)).toBe(false);
    expect(acpRegistryEnabled({})).toBe(false);
    expect(acpRegistryEnabled({ ACP_REGISTRY_ALLOWLIST: "" })).toBe(false);
  });

  it("comma list and wildcard", () => {
    expect(parseAcpAllowlist("claude-acp, amp-acp")).toEqual(new Set(["claude-acp", "amp-acp"]));
    expect(parseAcpAllowlist("*")).toBe("all");
    expect(acpRegistryEnabled({ ACP_REGISTRY_ALLOWLIST: "claude-acp" })).toBe(true);
  });

  it("rejects an entry that is not a registry id", () => {
    expect(() => parseAcpAllowlist("UPPER")).toThrow(AcpRegistryError);
  });
});

describe("acpModelToAgentId", () => {
  it("parses acp/<id> and acp/<id>@<version>", () => {
    expect(acpModelToAgentId("acp/claude-acp")).toEqual({ id: "claude-acp" });
    expect(acpModelToAgentId("acp/claude-acp@0.86.0")).toEqual({ id: "claude-acp", version: "0.86.0" });
  });

  it("returns null for non-acp models", () => {
    expect(acpModelToAgentId("anthropic/claude-sonnet-4")).toBeNull();
  });

  it("refuses a malformed id", () => {
    expect(() => acpModelToAgentId("acp/Not_An_Id")).toThrow(AcpRegistryError);
  });
});

describe("resolveAcpAgent", () => {
  it("errors on a missing id", () => {
    expect(() => resolveAcpAgent(REGISTRY, { id: "nope" })).toThrow(/not in the pinned registry/);
  });

  it("refuses a version pin the snapshot does not list", () => {
    expect(() => resolveAcpAgent(REGISTRY, { id: "claude-acp", version: "9.9.9" })).toThrow(
      /pins claude-acp at 0\.86\.0/,
    );
  });

  it("accepts a matching version pin", () => {
    const resolved = resolveAcpAgent(REGISTRY, { id: "claude-acp", version: "0.86.0" });
    expect(resolved.agent).toEqual({ id: "claude-acp", name: "Claude ACP", version: "0.86.0" });
  });

  it("resolves npx to a version-pinned npx spawn", () => {
    const r = resolveAcpAgent(REGISTRY, { id: "claude-acp" });
    expect(r.spawn).toEqual({
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp@0.86.0"],
      env: {},
    });
    expect(r.install).toEqual({ kind: "npx", package: "@agentclientprotocol/claude-agent-acp@0.86.0" });
    expect(r.installHosts).toEqual(["registry.npmjs.org"]);
  });

  it("prefers the requested binary platform and carries sha256 + env", () => {
    const r = resolveAcpAgent(REGISTRY, { id: "amp-acp", platform: "linux-x86_64" });
    expect(r.install).toEqual({
      kind: "binary",
      url: "https://ampcode.com/install/amp-acp-linux-x86_64.tar.gz",
      sha256: SHA,
    });
    expect(r.spawn.command).toBe("/opt/acp-agents/amp-acp/amp-acp");
    expect(r.spawn.env).toEqual({ AMP_LOG: "warn" });
    expect(r.installHosts).toEqual(["ampcode.com"]);
  });

  it("falls back to npx when the requested platform has no binary", () => {
    const r = resolveAcpAgent(REGISTRY, { id: "claude-acp", platform: "windows-x86_64" });
    expect(r.install.kind).toBe("npx");
  });

  it("resolves uvx when it is the only distribution", () => {
    const r = resolveAcpAgent(REGISTRY, { id: "fast-agent" });
    expect(r.install).toEqual({ kind: "uvx", package: "fast-agent-mcp" });
    expect(r.spawn.command).toBe("uvx");
    expect(r.spawn.args).toEqual(["fast-agent-mcp", "--serve"]);
    expect(r.installHosts).toEqual(["pypi.org"]);
  });

  it("errors when nothing covers the platform", () => {
    expect(() =>
      resolveAcpAgent({ version: "1", agents: [{ ...REGISTRY.agents[1]!, distribution: { binary: {} } }] }, { id: "amp-acp" }),
    ).toThrow(/no distribution for linux-x86_64/);
  });
});

describe("assertAcpAgentAllowed", () => {
  it("denies when the allowlist is absent", () => {
    expect(() => assertAcpAgentAllowed("claude-acp", undefined)).toThrow(AcpRegistryNotAllowed);
    expect(() => assertAcpAgentAllowed("claude-acp", { ACP_REGISTRY_ALLOWLIST: "" })).toThrow(AcpRegistryNotAllowed);
  });

  it("denies an unlisted id, allows a listed id and the wildcard", () => {
    expect(() => assertAcpAgentAllowed("nope", ALLOWED_ENV)).toThrow(/not allowlisted/);
    expect(() => assertAcpAgentAllowed("claude-acp", ALLOWED_ENV)).not.toThrow();
    expect(() => assertAcpAgentAllowed("anything", { ACP_REGISTRY_ALLOWLIST: "*" })).not.toThrow();
  });
});

describe("AcpRegistryHarness + resolveHarness", () => {
  it("the gate refuses the lane without an allowlist", () => {
    expect(() => resolveHarness("acp", {})).toThrow(/ACP_REGISTRY_ALLOWLIST/);
    expect(() => resolveHarness("acp")).toThrow(/not enabled/);
  });

  it("resolveHarness returns an env-bound instance when gated on", () => {
    const h = resolveHarness("acp", ALLOWED_ENV);
    expect(h.name).toBe("acp");
    expect(h.supportedProviders).toEqual(["acp"]);
  });

  it("egressHosts rejects a non-acp model", () => {
    const h = resolveHarness("acp", ALLOWED_ENV);
    expect(() => h.egressHosts("anthropic/claude-sonnet-4")).toThrow(/supports acp, not "anthropic"/);
  });

  it("egressHosts includes the provider host + install origin", () => {
    const h = resolveHarness("acp", ALLOWED_ENV);
    expect(h.egressHosts("acp/claude-acp")).toContain("registry.npmjs.org");
    expect(h.egressHosts("acp/amp-acp")).toContain("ampcode.com");
  });

  it("refuses a disallowed or unlisted id at admit time", () => {
    const h = resolveHarness("acp", ALLOWED_ENV);
    expect(() => h.egressHosts("acp/nope")).toThrow(AcpRegistryNotAllowed);
    expect(() => h.egressHosts("acp/fast-agent")).toThrow(AcpRegistryNotAllowed);
  });

  it("fails closed when the lane is on but no snapshot is pinned", () => {
    const h = resolveHarness("acp", { ACP_REGISTRY_ALLOWLIST: "*" });
    expect(() => h.egressHosts("acp/claude-acp")).toThrow(/ACP_REGISTRY_JSON is unset/);
  });

  it("the resolved harness spawns the shared ACP driver", () => {
    const h = resolveHarness("acp", ALLOWED_ENV);
    const argv = h.buildArgv(
      {
        id: "run1",
        task: "t",
        repo: "o/r",
        baseBranch: "main",
        codingModel: "acp/claude-acp",
        containerImage: "img",
        thread: { slackChannel: "C", threadTs: "1" },
      } as never,
      "/workspace",
    );
    expect(argv[0]).toBe("node");
    expect(argv[1]).toContain("acp-driver");
  });

  it("env carries the dummy key; capabilities are sandbox-only", () => {
    const h = resolveHarness("acp", ALLOWED_ENV);
    const env = h.env({ codingModel: "acp/claude-acp" } as never, null);
    expect(env.ACP_AGENT_API_KEY).toBeDefined();
    expect(h.capabilities().supportedRuntimes).toEqual(["sandbox"]);
    expect(h.capabilities().execAllowlist).toEqual([]);
  });
});
